// SPDX-License-Identifier: AGPL-3.0-only
// The VAT method and rate of an entity's marketplace sales (#4303 S3a, parent #2520), on PostgreSQL: dated rows, never edited (a change is a later row), refused inside a locked period, set by owners and
// admins and read by every role, all or none, the pair of method and rate kept by the database, a row in force on a date or none (the sales posting holds a month back on none), and the audit row.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import type { MarketplaceVatRates } from '@crove/kernel-contract';
import { Runtime, defineQuery } from '@crove/kernel-runtime';
import { financeCommands, financeQueries, marketplaceVatRateAt } from '@crove/mod-finance';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('marketplace VAT rate of an entity (#4303 S3a)', () => {
  const dbName = `crove_test_mkt_vat_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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
  const identity = (name: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@vatrate.test`, name: null });
  type Org = { orgId: string; owner: string; admin: string; member: string; viewer: string; entity: string };
  async function org(): Promise<Org> {
    const owner = await identity('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Công Ty Bán Sàn ${randomUUID().slice(0, 6)}`);
    const [adminUser, member, viewer] = await Promise.all([identity('admin'), identity('member'), identity('viewer')]);
    await admin((c) => c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'viewer')", [orgId, adminUser, member, viewer]));
    const entity = (await admin((c) => c.query<{ id: string }>('SELECT id FROM crove_kernel.legal_entity WHERE org_id = $1 AND is_default', [orgId]))).rows[0]?.id as string;
    return { orgId, owner, admin: adminUser, member, viewer, entity };
  }
  const execute = <T>(o: Org, name: string, input: unknown, user = o.owner) => rt.execute<T>(name, input, { actor: asUser(user), orgId: o.orgId, idempotencyKey: randomUUID() });
  const query = <T>(o: Org, name: string, input: unknown, user = o.owner) => rt.query<T>(name, input, { actor: asUser(user), orgId: o.orgId });
  type Row = { effectiveFrom: string; method: 'deduction' | 'none'; vatPercent: string | null };
  const setRates = (o: Org, rows: Row[], user = o.owner) => execute<MarketplaceVatRates>(o, 'finance.marketplace_vat_rate.set', { legalEntityId: o.entity, rows }, user);
  const list = (o: Org, user = o.owner) => query<MarketplaceVatRates>(o, 'finance.marketplace_vat_rate.list', { legalEntityId: o.entity }, user);
  const SCHEDULE: Row[] = [
    { effectiveFrom: '2026-01-01', method: 'deduction', vatPercent: '8' },
    { effectiveFrom: '2027-01-01', method: 'deduction', vatPercent: '10' },
  ];
  // The row the sales posting reads (S3b), through a probe query of the test that calls the module's own helper in the runtime's transaction, as the posting will.
  const probe = defineQuery({
    name: 't4303.vat_rate_at',
    input: z.object({ legalEntityId: z.string(), date: z.string() }),
    access: ['owner', 'admin', 'member', 'viewer'],
    handler: (ctx, input) => marketplaceVatRateAt(ctx, input.legalEntityId, input.date),
  });
  const rateAt = (o: Org, date: string) => query<Row | null>(o, 't4303.vat_rate_at', { legalEntityId: o.entity, date });

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
      queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries, probe],
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

  it('has no row until a person enters one, then lists them oldest first, and the row in force on a date is the latest that starts on or before it', async () => {
    const o = await org();
    expect(await list(o)).toEqual({ legalEntityId: o.entity, rows: [] });
    expect(await rateAt(o, '2026-06-30')).toBeNull();
    const done = await setRates(o, SCHEDULE);
    // The database keeps two decimals, so the answer reads the stored value: 8.00 for the 8 the person typed.
    expect(done.rows).toEqual([{ ...SCHEDULE[0], vatPercent: '8.00' }, { ...SCHEDULE[1], vatPercent: '10.00' }]);
    expect(await list(o)).toEqual(done);
    // Before the first row: none (the sales posting holds the month back); inside the first, the second from its date.
    expect(await rateAt(o, '2025-12-31')).toBeNull();
    expect(await rateAt(o, '2026-12-31')).toMatchObject({ method: 'deduction', vatPercent: '8.00' });
    expect(await rateAt(o, '2027-01-01')).toMatchObject({ method: 'deduction', vatPercent: '10.00' });
  });

  it('takes a new row only after the latest one and after a locked period, and never edits one in place', async () => {
    const o = await org();
    await setRates(o, [{ effectiveFrom: '2026-03-01', method: 'deduction', vatPercent: '8' }]);
    for (const date of ['2026-03-01', '2026-02-01']) await expect(setRates(o, [{ effectiveFrom: date, method: 'deduction', vatPercent: '10' }])).rejects.toMatchObject({ code: 'MARKETPLACE_VAT_RATE_ORDER' });
    await admin((c) =>
      c.query(
        "INSERT INTO crove_finance.period_lock (org_id, legal_entity_id, locked_from, locked_through) VALUES ($1, $2, '2026-01-01', '2026-06-30') ON CONFLICT (org_id, legal_entity_id) DO UPDATE SET locked_from = excluded.locked_from, locked_through = excluded.locked_through",
        [o.orgId, o.entity],
      ),
    );
    await expect(setRates(o, [{ effectiveFrom: '2026-06-30', method: 'deduction', vatPercent: '10' }])).rejects.toMatchObject({ code: 'MARKETPLACE_VAT_RATE_LOCKED' });
    await setRates(o, [{ effectiveFrom: '2026-07-01', method: 'deduction', vatPercent: '10' }]);
    expect((await list(o)).rows.map((r) => [r.effectiveFrom, r.vatPercent])).toEqual([['2026-03-01', '8.00'], ['2026-07-01', '10.00']]);
    // The database holds the same rule: the tenant role may not update or delete a row.
    await expect(admin((c) => c.query("SET ROLE crove_tenant; UPDATE crove_finance.marketplace_vat_rate SET vat_percent = 5 WHERE org_id = $1", [o.orgId]))).rejects.toBeDefined();
  });

  it('is all or none: a batch with a bad row stores nothing, and the dates must be ascending, in range and a real day', async () => {
    const o = await org();
    await expect(setRates(o, [{ effectiveFrom: '2026-01-01', method: 'deduction', vatPercent: '8' }, { effectiveFrom: '2026-01-01', method: 'deduction', vatPercent: '10' }])).rejects.toBeDefined();
    await expect(setRates(o, [{ effectiveFrom: '2026-01-01', method: 'deduction', vatPercent: null }])).rejects.toBeDefined();
    await expect(setRates(o, [{ effectiveFrom: '2026-01-01', method: 'none', vatPercent: '8' }])).rejects.toBeDefined();
    await expect(setRates(o, [{ effectiveFrom: '2026-01-01', method: 'deduction', vatPercent: '101' }])).rejects.toBeDefined();
    await expect(setRates(o, [{ effectiveFrom: '2026-01-01', method: 'deduction', vatPercent: '8.555' }])).rejects.toBeDefined();
    await expect(setRates(o, [{ effectiveFrom: '1999-12-31', method: 'deduction', vatPercent: '8' }])).rejects.toMatchObject({ code: 'MARKETPLACE_VAT_RATE_DATE' });
    await expect(setRates(o, [{ effectiveFrom: '2999-01-01', method: 'deduction', vatPercent: '8' }])).rejects.toMatchObject({ code: 'MARKETPLACE_VAT_RATE_DATE' });
    await expect(setRates(o, [{ effectiveFrom: '2026-02-30', method: 'deduction', vatPercent: '8' }])).rejects.toBeDefined();
    expect((await list(o)).rows).toEqual([]);
  });

  it('keeps `none` without a rate and lets a later row move an entity between the methods', async () => {
    const o = await org();
    await setRates(o, [{ effectiveFrom: '2026-01-01', method: 'none', vatPercent: null }]);
    await setRates(o, [{ effectiveFrom: '2026-07-01', method: 'deduction', vatPercent: '8.5' }]);
    expect((await list(o)).rows).toEqual([
      { effectiveFrom: '2026-01-01', method: 'none', vatPercent: null },
      { effectiveFrom: '2026-07-01', method: 'deduction', vatPercent: '8.50' },
    ]);
  });

  it('lets owners and admins set rates, every role read them, refuses another org its rows, and keeps the audit row to ids, dates, method and rate', async () => {
    const o = await org();
    await setRates(o, [SCHEDULE[0] as Row], o.admin);
    await expect(setRates(o, [SCHEDULE[1] as Row], o.member)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(setRates(o, [SCHEDULE[1] as Row], o.viewer)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    for (const who of [o.owner, o.admin, o.member, o.viewer]) expect((await list(o, who)).rows).toHaveLength(1);
    // Another org asking for this entity finds none of it.
    const other = await org();
    await expect(query(other, 'finance.marketplace_vat_rate.list', { legalEntityId: o.entity }, other.owner)).rejects.toBeDefined();
    const rows = await admin(async (c) => (await c.query<{ detail: Record<string, unknown> }>(`SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'finance.marketplace_vat_rate.set' AND outcome = 'ok'`, [o.orgId])).rows);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.detail).toMatchObject({ legalEntityId: o.entity, rows: [{ effectiveFrom: '2026-01-01', method: 'deduction', vatPercent: '8' }] });
  });
});

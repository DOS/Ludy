// SPDX-License-Identifier: AGPL-3.0-only
// What the org sets for its payment reminders (#2488, slice 3) on PostgreSQL 17: the terms default to 30 days and the weekly item to off, the owner or an admin sets
// both, a customer's own terms and pause are set by any member who may send reminders (a viewer reads and never writes), the settings sit on the kept party of a
// duplicate group, bad numbers and dates are refused before the database sees them, each change is audited with ids and numbers only, another org's party is not
// found, and a removed party takes its row with it. Set LUDY_TEST_ADMIN_URL (or CROVE_TEST_ADMIN_URL) to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import { CUSTOMER_COLLECTION_MAX, type CustomerCollectionList } from '@ludy/kernel-contract';
import { Runtime } from '@ludy/kernel-runtime';
import { financeCommands, financeQueries } from '@ludy/mod-finance';
import { enterUser } from './context-token.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

interface Setting {
  termsDays: number;
  weeklyItem: boolean;
}
interface Customer {
  partyId: string;
  termsDays: number | null;
  effectiveTermsDays: number;
  pausedUntil: string | null;
}

const daysFromNow = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

suite('payment reminder settings (#2488)', () => {
  const dbName = `ludy_test_collection_settings_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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
  const identity = (name: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@company.test`, name: null });
  type Org = { orgId: string; owner: string; admin: string; member: string; viewer: string };
  async function org(): Promise<Org> {
    const owner = await identity('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Công ty Cài Đặt ${randomUUID().slice(0, 6)}`);
    const [adminUser, member, viewer] = await Promise.all([identity('admin'), identity('member'), identity('viewer')]);
    await admin((c) =>
      c.query("INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'viewer')", [orgId, adminUser, member, viewer]),
    );
    return { orgId, owner, admin: adminUser, member, viewer };
  }
  const execute = <T>(o: Org, name: string, input: unknown, user = o.owner) => rt.execute<T>(name, input, { actor: asUser(user), orgId: o.orgId, idempotencyKey: randomUUID() });
  const query = <T>(o: Org, name: string, input: unknown, user = o.owner) => rt.query<T>(name, input, { actor: asUser(user), orgId: o.orgId });
  const customer = async (o: Org, name: string) => (await execute<{ partyId: string }>(o, 'kernel.party.create', { kind: 'organization', name })).partyId;
  const auditOf = (o: Org, command: string) =>
    admin(async (c) => (await c.query<{ detail: Record<string, unknown> }>(`SELECT detail FROM ludy_kernel.audit_event WHERE org_id = $1 AND command = $2 AND outcome = 'ok' ORDER BY occurred_at`, [o.orgId, command])).rows.map((r) => r.detail));

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
    const app = new URL(adminUrl);
    app.username = 'ludy_app';
    app.password = 'test-app-pw';
    pool = createPool({ connectionString: app.toString(), max: 4 });
    db = createDb(pool);
    rt = new Runtime(db, { manifests: TEST_MANIFESTS }).register({
      commands: [...kernelCommands, ...financeCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries],
    });
  });

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('defaults to 30 days and no weekly item, with no row made by reading', async () => {
    const o = await org();
    expect(await query<Setting>(o, 'finance.collection_setting.get', {}, o.viewer)).toEqual({ termsDays: 30, weeklyItem: false });
    const rows = await admin(async (c) => (await c.query('SELECT 1 FROM ludy_finance.collection_setting WHERE org_id = $1', [o.orgId])).rowCount);
    expect(rows).toBe(0);
  });

  it('is set by an owner or an admin, read by everyone, and refused to a member and a viewer', async () => {
    const o = await org();
    expect(await execute<Setting>(o, 'finance.collection_setting.set', { termsDays: 45, weeklyItem: true })).toEqual({ termsDays: 45, weeklyItem: true });
    expect(await execute<Setting>(o, 'finance.collection_setting.set', { termsDays: 15, weeklyItem: true }, o.admin)).toEqual({ termsDays: 15, weeklyItem: true });
    for (const user of [o.owner, o.admin, o.member, o.viewer]) expect(await query<Setting>(o, 'finance.collection_setting.get', {}, user)).toEqual({ termsDays: 15, weeklyItem: true });
    await expect(execute(o, 'finance.collection_setting.set', { termsDays: 10, weeklyItem: false }, o.member)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(execute(o, 'finance.collection_setting.set', { termsDays: 10, weeklyItem: false }, o.viewer)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // One row, whoever wrote it.
    const rows = await admin(async (c) => (await c.query('SELECT terms_days, weekly_item, set_by FROM ludy_finance.collection_setting WHERE org_id = $1', [o.orgId])).rows);
    expect(rows).toEqual([{ terms_days: 15, weekly_item: true, set_by: o.admin }]);
    // Each change is audited with the numbers and the switch.
    expect(await auditOf(o, 'finance.collection_setting.set')).toMatchObject([
      { termsDays: 45, previousTermsDays: 30, weeklyItem: true, previousWeeklyItem: false },
      { termsDays: 15, previousTermsDays: 45, weeklyItem: true, previousWeeklyItem: true },
    ]);
  });

  it('refuses terms outside 1 to 365 days, and keeps the previous settings', async () => {
    const o = await org();
    await execute(o, 'finance.collection_setting.set', { termsDays: 20, weeklyItem: false });
    for (const termsDays of [0, 366, 1.5, -3]) await expect(execute(o, 'finance.collection_setting.set', { termsDays, weeklyItem: false })).rejects.toMatchObject({ code: 'VALIDATION' });
    expect((await query<Setting>(o, 'finance.collection_setting.get', {})).termsDays).toBe(20);
  });

  it('keeps a customer\'s own terms and pause, with the terms that apply to it', async () => {
    const o = await org();
    const p = await customer(o, 'Công ty Khách Hàng Một');
    expect(await query<Customer>(o, 'finance.customer_collection.get', { partyId: p }, o.viewer)).toEqual({ partyId: p, termsDays: null, effectiveTermsDays: 30, pausedUntil: null });
    await execute(o, 'finance.collection_setting.set', { termsDays: 60, weeklyItem: false });
    const until = daysFromNow(30);
    expect(await execute<Customer>(o, 'finance.customer_collection.set', { partyId: p, termsDays: null, pausedUntil: until }, o.member)).toEqual({ partyId: p, termsDays: null, effectiveTermsDays: 60, pausedUntil: until });
    expect(await execute<Customer>(o, 'finance.customer_collection.set', { partyId: p, termsDays: 14, pausedUntil: null }, o.admin)).toEqual({ partyId: p, termsDays: 14, effectiveTermsDays: 14, pausedUntil: null });
    expect(await query<Customer>(o, 'finance.customer_collection.get', { partyId: p }, o.viewer)).toMatchObject({ termsDays: 14, pausedUntil: null });
    await expect(execute(o, 'finance.customer_collection.set', { partyId: p, termsDays: 7, pausedUntil: null }, o.viewer)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const rows = await admin(async (c) => (await c.query('SELECT party_id, terms_days, paused_until::text AS paused_until FROM ludy_finance.customer_collection WHERE org_id = $1', [o.orgId])).rows);
    expect(rows).toEqual([{ party_id: p, terms_days: 14, paused_until: null }]);
    const audit = await auditOf(o, 'finance.customer_collection.set');
    expect(audit).toMatchObject([
      { partyId: p, termsDays: null, pausedUntil: until, previousTermsDays: null, previousPausedUntil: null, changed: true },
      { partyId: p, termsDays: 14, pausedUntil: null, previousPausedUntil: until, changed: true },
    ]);
    expect(JSON.stringify(audit)).not.toContain('Khách Hàng Một');
  });

  it('makes no row for a customer with nothing to keep, and clears a pause with a row left', async () => {
    const o = await org();
    const p = await customer(o, 'Công ty Khách Hàng Hai');
    await execute(o, 'finance.customer_collection.set', { partyId: p, termsDays: null, pausedUntil: null });
    expect(await admin(async (c) => (await c.query('SELECT 1 FROM ludy_finance.customer_collection WHERE org_id = $1', [o.orgId])).rowCount)).toBe(0);
    await execute(o, 'finance.customer_collection.set', { partyId: p, termsDays: null, pausedUntil: daysFromNow(5) });
    await execute(o, 'finance.customer_collection.set', { partyId: p, termsDays: null, pausedUntil: null });
    expect(await query<Customer>(o, 'finance.customer_collection.get', { partyId: p })).toMatchObject({ termsDays: null, pausedUntil: null });
    expect(await admin(async (c) => (await c.query('SELECT 1 FROM ludy_finance.customer_collection WHERE org_id = $1', [o.orgId])).rowCount)).toBe(1);
  });

  it('refuses a pause that is not a date or runs past two years, and terms outside the range', async () => {
    const o = await org();
    const p = await customer(o, 'Công ty Khách Hàng Ba');
    // A string that is no date at all is the contract's; a well-formed one that is no day (or too early for the database) is the command's.
    await expect(execute(o, 'finance.customer_collection.set', { partyId: p, termsDays: null, pausedUntil: 'tomorrow' })).rejects.toMatchObject({ code: 'VALIDATION' });
    for (const pausedUntil of ['2026-02-30', '2026-13-01', '0000-01-01', '1999-12-31']) {
      await expect(execute(o, 'finance.customer_collection.set', { partyId: p, termsDays: null, pausedUntil }), pausedUntil).rejects.toMatchObject({ code: 'PAUSE_DATE_INVALID' });
    }
    await expect(execute(o, 'finance.customer_collection.set', { partyId: p, termsDays: null, pausedUntil: daysFromNow(800) })).rejects.toMatchObject({ code: 'PAUSE_TOO_LONG' });
    await expect(execute(o, 'finance.customer_collection.set', { partyId: p, termsDays: 0, pausedUntil: null })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(execute(o, 'finance.customer_collection.set', { partyId: p, termsDays: 400, pausedUntil: null })).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(await admin(async (c) => (await c.query('SELECT 1 FROM ludy_finance.customer_collection WHERE org_id = $1', [o.orgId])).rowCount)).toBe(0);
  });

  it('sits on the kept party of a duplicate group, whichever party is named', async () => {
    const o = await org();
    const kept = await customer(o, 'Công ty Giữ Lại');
    const dup = await customer(o, 'Công ty Trùng');
    await admin((c) => c.query('UPDATE ludy_kernel.party SET duplicate_of = $3 WHERE org_id = $1 AND id = $2', [o.orgId, dup, kept]));
    expect(await execute<Customer>(o, 'finance.customer_collection.set', { partyId: dup, termsDays: 21, pausedUntil: null })).toMatchObject({ partyId: kept, termsDays: 21 });
    expect(await query<Customer>(o, 'finance.customer_collection.get', { partyId: kept })).toMatchObject({ partyId: kept, termsDays: 21 });
    expect(await query<Customer>(o, 'finance.customer_collection.get', { partyId: dup })).toMatchObject({ partyId: kept, termsDays: 21 });
    expect(await admin(async (c) => (await c.query('SELECT party_id FROM ludy_finance.customer_collection WHERE org_id = $1', [o.orgId])).rows)).toEqual([{ party_id: kept }]);
  });

  // The runtime refuses a role before the database is asked; these go straight to SQL as ludy_app, in the context of each role's user, so the row policies and the
  // column grants of the migration are what answers.
  it('holds the row policies and the grants in SQL: a member and a viewer write nothing of the org\'s, a viewer nothing of a customer\'s, nobody deletes, no key changes', async () => {
    const o = await org();
    const p = await customer(o, 'Công ty Chính Sách');
    const other = await customer(o, 'Công ty Chính Sách Hai');
    await execute(o, 'finance.collection_setting.set', { termsDays: 30, weeklyItem: false });
    await execute(o, 'finance.customer_collection.set', { partyId: p, termsDays: 20, pausedUntil: null });
    async function inContext<T>(who: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await enterUser(c, who, o.orgId);
        return await fn(c);
      } finally {
        await c.query('ROLLBACK').catch(() => undefined);
        c.release();
      }
    }
    // A refused statement aborts its transaction: each one has a context of its own.
    const refused = (who: string, sqlText: string, params: unknown[], message: string) => inContext(who, (c) => expect(c.query(sqlText, params)).rejects.toMatchObject({ code: '42501', message: expect.stringContaining(message) }));
    const changed = (who: string, sqlText: string, params: unknown[]) => inContext(who, async (c) => (await c.query(sqlText, params)).rowCount);

    // The org's settings: an owner and an admin update the one row, a member and a viewer change none and insert none.
    for (const who of [o.owner, o.admin]) expect(await changed(who, 'UPDATE ludy_finance.collection_setting SET terms_days = 31 WHERE org_id = $1', [o.orgId]), who).toBe(1);
    for (const who of [o.member, o.viewer]) {
      expect(await changed(who, 'UPDATE ludy_finance.collection_setting SET terms_days = 9 WHERE org_id = $1', [o.orgId]), who).toBe(0);
      await refused(who, 'INSERT INTO ludy_finance.collection_setting (org_id) VALUES ($1)', [o.orgId], 'row-level security');
    }
    // A customer's: a member and an owner insert and update, a viewer does neither.
    expect(await changed(o.member, 'UPDATE ludy_finance.customer_collection SET terms_days = 21 WHERE org_id = $1 AND party_id = $2', [o.orgId, p])).toBe(1);
    expect(await changed(o.member, 'INSERT INTO ludy_finance.customer_collection (org_id, party_id, terms_days) VALUES ($1, $2, 45)', [o.orgId, other])).toBe(1);
    expect(await changed(o.viewer, 'UPDATE ludy_finance.customer_collection SET terms_days = 9 WHERE org_id = $1 AND party_id = $2', [o.orgId, p])).toBe(0);
    await refused(o.viewer, 'INSERT INTO ludy_finance.customer_collection (org_id, party_id, terms_days) VALUES ($1, $2, 9)', [o.orgId, other], 'row-level security');
    // Nobody deletes, whatever the role: there is no DELETE grant.
    for (const who of [o.owner, o.admin, o.member, o.viewer]) {
      await refused(who, 'DELETE FROM ludy_finance.collection_setting WHERE org_id = $1', [o.orgId], 'permission denied');
      await refused(who, 'DELETE FROM ludy_finance.customer_collection WHERE org_id = $1', [o.orgId], 'permission denied');
    }
    // No key changes: only the value columns, who set them and when are granted.
    await refused(o.owner, 'UPDATE ludy_finance.customer_collection SET party_id = $2 WHERE org_id = $1 AND party_id = $3', [o.orgId, other, p], 'permission denied');
    await refused(o.owner, 'UPDATE ludy_finance.customer_collection SET org_id = org_id WHERE org_id = $1', [o.orgId], 'permission denied');
    await refused(o.owner, 'UPDATE ludy_finance.collection_setting SET org_id = org_id WHERE org_id = $1', [o.orgId], 'permission denied');
    // Another org's owner cannot even enter this org's context, so none of it is reached.
    const b = await org();
    await expect(inContext(b.owner, async (c) => c.query('SELECT 1 FROM ludy_finance.collection_setting'))).rejects.toMatchObject({ message: 'NOT_A_MEMBER' });
  });

  it('does not find another org\'s party, and keeps each org\'s settings apart', async () => {
    const a = await org();
    const b = await org();
    const p = await customer(a, 'Công ty Của A');
    await expect(query(b, 'finance.customer_collection.get', { partyId: p })).rejects.toMatchObject({ code: 'PARTY_NOT_FOUND' });
    await expect(execute(b, 'finance.customer_collection.set', { partyId: p, termsDays: 9, pausedUntil: null })).rejects.toMatchObject({ code: 'PARTY_NOT_FOUND' });
    await execute(a, 'finance.collection_setting.set', { termsDays: 90, weeklyItem: true });
    expect(await query<Setting>(b, 'finance.collection_setting.get', {})).toEqual({ termsDays: 30, weeklyItem: false });
  });

  it('goes with the party that is removed (the purge of an org lists both tables: org-purge-coverage.test.ts)', async () => {
    const o = await org();
    const p = await customer(o, 'Công ty Bị Xóa');
    await execute(o, 'finance.customer_collection.set', { partyId: p, termsDays: 10, pausedUntil: null });
    await execute(o, 'finance.collection_setting.set', { termsDays: 40, weeklyItem: true });
    await admin((c) => c.query('DELETE FROM ludy_kernel.party WHERE org_id = $1 AND id = $2', [o.orgId, p]));
    expect(await admin(async (c) => (await c.query('SELECT 1 FROM ludy_finance.customer_collection WHERE org_id = $1', [o.orgId])).rowCount)).toBe(0);
    expect(await admin(async (c) => (await c.query('SELECT 1 FROM ludy_finance.collection_setting WHERE org_id = $1', [o.orgId])).rowCount)).toBe(1);
  });

  it('reads the settings a party held before it was merged, writes only on the kept party, audits "changed" only when something changed, and serializes two writers', async () => {
    const o = await org();
    const kept = await customer(o, 'Công ty Giữ Lại Ba');
    const dup = await customer(o, 'Công ty Trùng Ba');
    const until = daysFromNow(15);
    await execute(o, 'finance.customer_collection.set', { partyId: dup, termsDays: 40, pausedUntil: until });
    await admin((c) => c.query('UPDATE ludy_kernel.party SET duplicate_of = $3 WHERE org_id = $1 AND id = $2', [o.orgId, dup, kept]));
    // The row stayed on the duplicate; the group still shows it, from either party.
    for (const who of [kept, dup]) expect(await query<Customer>(o, 'finance.customer_collection.get', { partyId: who })).toEqual({ partyId: kept, termsDays: 40, effectiveTermsDays: 40, pausedUntil: until });
    // A set through the duplicate writes the kept party's row, which then wins.
    await execute(o, 'finance.customer_collection.set', { partyId: dup, termsDays: 10, pausedUntil: null });
    expect(await query<Customer>(o, 'finance.customer_collection.get', { partyId: kept })).toMatchObject({ termsDays: 10, pausedUntil: null });
    // The same values again change nothing: audited as unchanged, and the row keeps who set it and when.
    const before = await admin(async (c) => (await c.query('SELECT updated_at::text AS at FROM ludy_finance.customer_collection WHERE org_id = $1 AND party_id = $2', [o.orgId, kept])).rows[0]);
    await execute(o, 'finance.customer_collection.set', { partyId: kept, termsDays: 10, pausedUntil: null }, o.member);
    expect(await admin(async (c) => (await c.query('SELECT updated_at::text AS at, set_by FROM ludy_finance.customer_collection WHERE org_id = $1 AND party_id = $2', [o.orgId, kept])).rows[0])).toMatchObject({ at: before?.at, set_by: o.owner });
    const audit = await auditOf(o, 'finance.customer_collection.set');
    expect(audit.map((a) => a.changed)).toEqual([true, true, false]);
    // Two writers at once: each audit row names what the other left (one chain, never two writers reading the same old value).
    const fresh = await customer(o, 'Công ty Hai Người Ghi');
    await Promise.all([
      execute(o, 'finance.customer_collection.set', { partyId: fresh, termsDays: 11, pausedUntil: null }),
      execute(o, 'finance.customer_collection.set', { partyId: fresh, termsDays: 12, pausedUntil: null }, o.admin),
    ]);
    const chain = (await auditOf(o, 'finance.customer_collection.set')).filter((a) => a.partyId === fresh);
    expect(chain).toHaveLength(2);
    // (The audit rows are stamped when each transaction starts, not in the order the lock let them write: find the first writer by its previous value.)
    const first = chain.find((a) => a.previousTermsDays === null);
    const second = chain.find((a) => a !== first);
    expect(first).toBeDefined();
    expect(second?.previousTermsDays).toBe(first?.termsDays);
    await Promise.all([
      execute(o, 'finance.collection_setting.set', { termsDays: 21, weeklyItem: false }),
      execute(o, 'finance.collection_setting.set', { termsDays: 22, weeklyItem: false }, o.admin),
    ]);
    const orgChain = await auditOf(o, 'finance.collection_setting.set');
    const firstOrg = orgChain.find((a) => a.previousTermsDays === 30);
    expect(firstOrg).toBeDefined();
    expect(orgChain.find((a) => a !== firstOrg)?.previousTermsDays).toBe(firstOrg?.termsDays);
  });

  it('answers the same terms for a merged group whose kept party has no row: the lowest party id wins a tie', async () => {
    const o = await org();
    const kept = await customer(o, 'Công ty Giữ Lại Bốn');
    const one = await customer(o, 'Công ty Trùng Bốn A');
    const two = await customer(o, 'Công ty Trùng Bốn B');
    await execute(o, 'finance.customer_collection.set', { partyId: one, termsDays: 20, pausedUntil: null });
    await execute(o, 'finance.customer_collection.set', { partyId: two, termsDays: 40, pausedUntil: null });
    for (const dup of [one, two]) await admin((c) => c.query('UPDATE ludy_kernel.party SET duplicate_of = $3 WHERE org_id = $1 AND id = $2', [o.orgId, dup, kept]));
    const expected = one < two ? 20 : 40;
    for (let i = 0; i < 3; i++) expect(await query<Customer>(o, 'finance.customer_collection.get', { partyId: kept })).toMatchObject({ partyId: kept, termsDays: expected });
    // A pause set on a duplicate is not hidden by a row of the kept party that holds only terms; the latest pause of the group stands.
    const keptTwo = await customer(o, 'Công ty Giữ Lại Sáu');
    const dupTwo = await customer(o, 'Công ty Trùng Sáu');
    const pause = daysFromNow(20);
    await execute(o, 'finance.customer_collection.set', { partyId: keptTwo, termsDays: 45 });
    await execute(o, 'finance.customer_collection.set', { partyId: dupTwo, pausedUntil: pause });
    await admin((c) => c.query('UPDATE ludy_kernel.party SET duplicate_of = $3 WHERE org_id = $1 AND id = $2', [o.orgId, dupTwo, keptTwo]));
    expect(await query<Customer>(o, 'finance.customer_collection.get', { partyId: keptTwo })).toEqual({ partyId: keptTwo, termsDays: 45, effectiveTermsDays: 45, pausedUntil: pause });
    // Lifting it through the kept party lifts the whole group's pause and keeps the terms (a field left out keeps its value), and a viewer cannot.
    await expect(execute(o, 'finance.customer_collection.set', { partyId: keptTwo, pausedUntil: null }, o.viewer)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await execute<Customer>(o, 'finance.customer_collection.set', { partyId: keptTwo, pausedUntil: null }, o.member)).toEqual({ partyId: keptTwo, termsDays: 45, effectiveTermsDays: 45, pausedUntil: null });
    expect(await query<Customer>(o, 'finance.customer_collection.get', { partyId: dupTwo })).toMatchObject({ partyId: keptTwo, pausedUntil: null });
    // A set through a duplicate lands on the kept party (the locks of lockedKeptParty see the merge) and wins from then on.
    await execute(o, 'finance.customer_collection.set', { partyId: two, termsDays: 55, pausedUntil: null });
    expect(await query<Customer>(o, 'finance.customer_collection.get', { partyId: one })).toMatchObject({ partyId: kept, termsDays: 55 });
  });

  it('lists customers with custom payment terms regardless of invoices or pauses, supports clearing, enforces viewer read-only, isolates orgs, and bounds results (#2544)', async () => {
    const o = await org();
    const otherOrg = await org();
    expect(await query<CustomerCollectionList>(o, 'finance.customer_collection.list', {}, o.viewer)).toEqual({ orgTermsDays: 30, customers: [], more: false });

    const onlyTerms = await customer(o, 'Công ty Bê Tông');
    const pausedAndTerms = await customer(o, 'Công ty An Khang');
    const expiredPauseAndTerms = await customer(o, 'Công ty Cát Lợi');
    const onlyPaused = await customer(o, 'Công ty Tạm Dừng Riêng');
    const foreignCustomer = await customer(otherOrg, 'Công ty Tổ Chức Khác');

    const futurePause = daysFromNow(14);
    const pastPause = daysFromNow(-2);
    // Customers with custom terms and zero invoices/overdue items, plus a paused-only customer and a different org's customer.
    await execute(o, 'finance.collection_setting.set', { termsDays: 45, weeklyItem: false });
    await execute(o, 'finance.customer_collection.set', { partyId: onlyTerms, termsDays: 60 }, o.member);
    await execute(o, 'finance.customer_collection.set', { partyId: pausedAndTerms, termsDays: 20, pausedUntil: futurePause }, o.admin);
    await execute(o, 'finance.customer_collection.set', { partyId: expiredPauseAndTerms, termsDays: 90, pausedUntil: pastPause });
    await execute(o, 'finance.customer_collection.set', { partyId: onlyPaused, termsDays: null, pausedUntil: futurePause });
    await execute(otherOrg, 'finance.customer_collection.set', { partyId: foreignCustomer, termsDays: 15 });

    // Every role including viewer reads the list; paused-only and other-org rows stay out; sorted deterministically by name then partyId.
    for (const reader of [o.owner, o.admin, o.member, o.viewer]) {
      const res = await query<CustomerCollectionList>(o, 'finance.customer_collection.list', {}, reader);
      expect(res).toEqual({
        orgTermsDays: 45,
        customers: [
          { partyId: pausedAndTerms, name: 'Công ty An Khang', termsDays: 20, pausedUntil: futurePause, paused: true },
          { partyId: onlyTerms, name: 'Công ty Bê Tông', termsDays: 60, pausedUntil: null, paused: false },
          { partyId: expiredPauseAndTerms, name: 'Công ty Cát Lợi', termsDays: 90, pausedUntil: pastPause, paused: false },
        ],
        more: false,
      });
    }
    expect(await query<CustomerCollectionList>(otherOrg, 'finance.customer_collection.list', {})).toEqual({
      orgTermsDays: 30,
      customers: [{ partyId: foreignCustomer, name: 'Công ty Tổ Chức Khác', termsDays: 15, pausedUntil: null, paused: false }],
      more: false,
    });

    // Viewer cannot mutate or clear; member/admin/owner can edit and clear (clearing keeps any active pause intact).
    await expect(execute(o, 'finance.customer_collection.set', { partyId: onlyTerms, termsDays: null }, o.viewer)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await execute(o, 'finance.customer_collection.set', { partyId: pausedAndTerms, termsDays: null }, o.member);
    expect(await query<Customer>(o, 'finance.customer_collection.get', { partyId: pausedAndTerms })).toMatchObject({ termsDays: null, effectiveTermsDays: 45, pausedUntil: futurePause });
    await execute(o, 'finance.customer_collection.set', { partyId: onlyTerms, termsDays: 75 }, o.admin);
    const afterEdit = await query<CustomerCollectionList>(o, 'finance.customer_collection.list', {});
    expect(afterEdit.customers.map((c) => [c.partyId, c.termsDays])).toEqual([
      [onlyTerms, 75],
      [expiredPauseAndTerms, 90],
    ]);

    // Merged duplicate group: duplicate's custom terms + kept party's pause show once under the kept party, and clearing removes the group.
    const kept = await customer(o, 'Công ty Giữ Gộp');
    const dup = await customer(o, 'Công ty Bị Gộp');
    await execute(o, 'finance.customer_collection.set', { partyId: kept, pausedUntil: futurePause });
    await execute(o, 'finance.customer_collection.set', { partyId: dup, termsDays: 50 });
    await admin((c) => c.query('UPDATE ludy_kernel.party SET duplicate_of = $3 WHERE org_id = $1 AND id = $2', [o.orgId, dup, kept]));
    const withDup = await query<CustomerCollectionList>(o, 'finance.customer_collection.list', {});
    expect(withDup.customers.find((c) => c.partyId === kept)).toEqual({ partyId: kept, name: 'Công ty Giữ Gộp', termsDays: 50, pausedUntil: futurePause, paused: true });
    expect(withDup.customers.some((c) => c.partyId === dup)).toBe(false);
    await execute(o, 'finance.customer_collection.set', { partyId: kept, termsDays: null });
    expect((await query<CustomerCollectionList>(o, 'finance.customer_collection.list', {})).customers.some((c) => c.partyId === kept)).toBe(false);

    // Bounded list at CUSTOMER_COLLECTION_MAX (200) sets `more: true` deterministically without dropping the first customers by name.
    const bounded = await org();
    await admin(async (c) => {
      await c.query(
        `WITH inserted AS (
           INSERT INTO ludy_kernel.party (org_id, kind, name)
           SELECT $1, 'organization', 'Khách ' || lpad(i::text, 3, '0')
           FROM generate_series(1, $2) AS i
           RETURNING id
         )
         INSERT INTO ludy_finance.customer_collection (org_id, party_id, terms_days)
         SELECT $1, id, 40 FROM inserted`,
        [bounded.orgId, CUSTOMER_COLLECTION_MAX + 1],
      );
    });
    const capped = await query<CustomerCollectionList>(bounded, 'finance.customer_collection.list', {});
    expect(capped.customers).toHaveLength(CUSTOMER_COLLECTION_MAX);
    expect(capped.more).toBe(true);
    expect(capped.customers[0]?.name).toBe('Khách 001');
    expect(capped.customers[CUSTOMER_COLLECTION_MAX - 1]?.name).toBe(`Khách ${String(CUSTOMER_COLLECTION_MAX).padStart(3, '0')}`);
  });
});

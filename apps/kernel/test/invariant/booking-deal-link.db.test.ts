// SPDX-License-Identifier: AGPL-3.0-only
// A booking's link to a deal (#3103, docs/plan/calendar.md "Deal links") on PostgreSQL 17: crove_crm.booking.deal_id is keyed with the org, so a booking of one org can never
// name a deal of another, whoever writes it (a member, the worker's system context, the public page's definer), and an org's members cannot reach another org's booking to change
// its link. A deal that is deleted leaves its bookings in place with the link cleared; the public page's definer is executable by the API's login alone.
// Part of the invariant suite; it imports package code under test, never helpers from outside test/invariant/.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';
import { contextToken } from './fixtures/context-token.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

interface OrgRows {
  orgId: string;
  slug: string;
  owner: string;
  party: string;
  deal: string;
  eventType: string;
  booking: string;
}

suite('a booking never names another org\'s deal on PostgreSQL (#3103)', () => {
  const dbName = `crove_test_booking_deal_inv_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let workerUrl = '';
  const pools: pg.Pool[] = [];
  let a: OrgRows;
  let b: OrgRows;
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }

  // Runs fn as a login role, after entering a context when one is given; always rolled back.
  async function inContext<T>(url: string, enter: ((c: pg.Client) => Promise<unknown>) | null, fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    try {
      await c.query('BEGIN');
      if (enter) await enter(c);
      return await fn(c);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      await c.end();
    }
  }
  const asMember = <T>(o: OrgRows, fn: (c: pg.Client) => Promise<T>) =>
    inContext(appUrl, (c) => c.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [o.orgId, contextToken(o.owner, o.orgId)]), fn);
  const asSystem = <T>(o: OrgRows, fn: (c: pg.Client) => Promise<T>) => inContext(workerUrl, (c) => c.query('SELECT crove_kernel.enter_system_context($1::uuid)', [o.orgId]), fn);
  // What a statement did: its row count, or the SQLSTATE of its refusal.
  const outcome = (p: Promise<pg.QueryResult>) =>
    p.then(
      (r) => ({ rows: r.rowCount ?? 0, code: '' }),
      (error: { code?: string }) => ({ rows: -1, code: error.code ?? '?' }),
    );
  const dealOf = async (c: pg.Client, o: OrgRows) => (await c.query<{ deal_id: string | null }>('SELECT deal_id FROM crove_crm.booking WHERE org_id = $1 AND id = $2', [o.orgId, o.booking])).rows[0]?.deal_id;

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
    const login = (username: string, password: string) => {
      const url = new URL(adminUrl);
      url.username = username;
      url.password = password;
      return url.toString();
    };
    appUrl = login('crove_app', 'test-app-pw');
    workerUrl = login('crove_worker', 'test-worker-pw');
    const pool = createPool({ connectionString: appUrl, max: 4 });
    pools.push(pool);
    const db = createDb(pool);
    const runtime = new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands], queries: [...kernelQueries({ inboundDomain: 'in.test' })] });
    const make = async (name: string): Promise<OrgRows> => {
      const owner = await upsertIdentity(db, { issuer: 'booking-deal-link', subject: name, email: `${name}@booking-deal-link.test`, name: null });
      const { orgId } = await createOrg(runtime, asUser(owner), `Công ty ${name}`);
      return admin(async (c) => {
        const slug = (await c.query<{ slug: string }>('SELECT slug FROM crove_kernel.tenant WHERE org_id = $1', [orgId])).rows[0]!.slug;
        const party = (await c.query<{ id: string }>("INSERT INTO crove_kernel.party (org_id, name, kind) VALUES ($1, 'Khách', 'person') RETURNING id", [orgId])).rows[0]!.id;
        const stage = (await c.query<{ id: string }>("INSERT INTO crove_crm.pipeline_stage (org_id, name, kind, position) VALUES ($1, 'Mới', 'open', 1) RETURNING id", [orgId])).rows[0]!.id;
        const deal = (await c.query<{ id: string }>("INSERT INTO crove_crm.deal (org_id, party_id, title, stage_id, sort_key, created_by) VALUES ($1, $2, 'Cơ hội', $3, 'V', $4) RETURNING id", [orgId, party, stage, owner])).rows[0]!.id;
        const eventType = (await c.query<{ id: string }>("INSERT INTO crove_crm.event_type (org_id, slug, title, duration_min, host_user_id, created_by) VALUES ($1, 'tu-van', 'Tư vấn', 30, $2, $2) RETURNING id", [orgId, owner])).rows[0]!.id;
        const start = new Date(Date.UTC(2032, 0, 1, name === 'a' ? 1 : 3));
        const event = (
          await c.query<{ id: string }>(
            "INSERT INTO crove_kernel.calendar_event (org_id, user_id, starts_at, ends_at, time_zone, title, kind, created_by) VALUES ($1, $2, $3, $4, 'Asia/Ho_Chi_Minh', 'Tư vấn', 'booking', $2) RETURNING id",
            [orgId, owner, start.toISOString(), new Date(start.getTime() + 1_800_000).toISOString()],
          )
        ).rows[0]!.id;
        const booking = (
          await c.query<{ id: string }>(
            "INSERT INTO crove_crm.booking (org_id, event_type_id, starts_at, ends_at, status, calendar_event_id, visitor_name, email, time_zone) VALUES ($1, $2, $3, $4, 'confirmed', $5, 'Khách', 'khach@booking-deal-link.test', 'Asia/Ho_Chi_Minh') RETURNING id",
            [orgId, eventType, start.toISOString(), new Date(start.getTime() + 1_800_000).toISOString(), event],
          )
        ).rows[0]!.id;
        return { orgId, slug, owner, party, deal, eventType, booking };
      });
    };
    a = await make('a');
    b = await make('b');
  });

  afterAll(async () => {
    await Promise.all(pools.map((p) => p.end()));
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('refuses a deal of another org from every writer, and takes the org\'s own', async () => {
    const link = (c: pg.Client, deal: string) => outcome(c.query('UPDATE crove_crm.booking SET deal_id = $3 WHERE org_id = $1 AND id = $2', [a.orgId, a.booking, deal]));
    // A member of org A, and the worker's system context for org A: another org's deal breaks the (org_id, deal_id) key; the org's own deal links.
    for (const as of [asMember, asSystem]) {
      expect(await as(a, (c) => link(c, b.deal))).toEqual({ rows: -1, code: '23503' });
      expect(await as(a, (c) => link(c, randomUUID()))).toEqual({ rows: -1, code: '23503' });
      expect(await as(a, async (c) => [await link(c, a.deal), await dealOf(c, a)])).toEqual([{ rows: 1, code: '' }, a.deal]);
    }
    // A new booking of org A that names org B's deal is refused as well.
    const insert = (c: pg.Client, deal: string) =>
      outcome(
        c.query(
          "INSERT INTO crove_crm.booking (org_id, event_type_id, starts_at, ends_at, status, visitor_name, email, time_zone, deal_id) VALUES ($1, $2, now() + interval '2 days', now() + interval '2 days 30 minutes', 'pending', 'Khách', 'moi@booking-deal-link.test', 'Asia/Ho_Chi_Minh', $3)",
          [a.orgId, a.eventType, deal],
        ),
      );
    expect(await asMember(a, (c) => insert(c, b.deal))).toEqual({ rows: -1, code: '23503' });
    expect(await asMember(a, (c) => insert(c, a.deal))).toEqual({ rows: 1, code: '' });
    // Nothing of that stayed: every write above was rolled back.
    expect(await admin((c) => dealOf(c, a))).toBeNull();
  });

  it('shows org B nothing of org A\'s booking and lets it change none of its links', async () => {
    await admin((c) => c.query('UPDATE crove_crm.booking SET deal_id = $3 WHERE org_id = $1 AND id = $2', [a.orgId, a.booking, a.deal]));
    try {
      for (const as of [asMember, asSystem]) {
        expect(await as(b, async (c) => (await c.query('SELECT 1 FROM crove_crm.booking WHERE org_id = $1', [a.orgId])).rowCount)).toBe(0);
        // The write names org A's row from org B's context: no row is visible to change, so nothing changes.
        expect(await as(b, (c) => outcome(c.query('UPDATE crove_crm.booking SET deal_id = NULL WHERE org_id = $1 AND id = $2', [a.orgId, a.booking])))).toEqual({ rows: 0, code: '' });
        // A booking row written for org A from org B's context is refused by the row policy, whatever deal it names.
        const forged = (c: pg.Client, deal: string | null) =>
          outcome(
            c.query(
              "INSERT INTO crove_crm.booking (org_id, event_type_id, starts_at, ends_at, status, visitor_name, email, time_zone, deal_id) VALUES ($1, $2, now() + interval '3 days', now() + interval '3 days 30 minutes', 'pending', 'Khách', 'x@booking-deal-link.test', 'Asia/Ho_Chi_Minh', $3)",
              [a.orgId, a.eventType, deal],
            ),
          );
        expect(await as(b, (c) => forged(c, null))).toEqual({ rows: -1, code: '42501' });
        expect(await as(b, (c) => forged(c, b.deal))).toEqual({ rows: -1, code: '42501' });
      }
      expect(await admin((c) => dealOf(c, a))).toBe(a.deal);
    } finally {
      await admin((c) => c.query('UPDATE crove_crm.booking SET deal_id = NULL WHERE org_id = $1 AND id = $2', [a.orgId, a.booking]));
    }
  });

  it('clears the link of a deal that is deleted and keeps the booking', async () => {
    await admin((c) => c.query('UPDATE crove_crm.booking SET deal_id = $3 WHERE org_id = $1 AND id = $2', [a.orgId, a.booking, a.deal]));
    const seen = await asMember(a, async (c) => {
      await c.query('DELETE FROM crove_crm.deal WHERE org_id = $1 AND id = $2', [a.orgId, a.deal]);
      return (await c.query<{ status: string; deal_id: string | null }>('SELECT status, deal_id FROM crove_crm.booking WHERE org_id = $1 AND id = $2', [a.orgId, a.booking])).rows[0];
    });
    expect(seen).toEqual({ status: 'confirmed', deal_id: null });
    await admin((c) => c.query('UPDATE crove_crm.booking SET deal_id = NULL WHERE org_id = $1 AND id = $2', [a.orgId, a.booking]));
  });

  it('lets a request name a deal of its own org alone, and only the API\'s login run the definer', async () => {
    const request = (c: pg.Client, org: OrgRows, deal: string | null) =>
      c
        .query<{ id: string | null }>(
          "SELECT crove_crm.booking_request_deal($1, 'tu-van', now() + interval '2 days', 'Khách web', 'web@booking-deal-link.test', NULL, NULL, 'Asia/Ho_Chi_Minh', $2::bytea, $3::uuid) AS id",
          [org.slug, `\\x${randomBytes(32).toString('hex')}`, deal],
        )
        .then((r) => r.rows[0]?.id ?? null);
    const dealOfRequest = async (c: pg.Client, org: OrgRows, id: string | null) =>
      (await c.query<{ deal_id: string | null }>('SELECT deal_id FROM crove_crm.booking WHERE org_id = $1 AND id = $2', [org.orgId, id])).rows[0]?.deal_id;
    // Org A's request that names org A's deal keeps it; one that names org B's deal, or nothing, has none, and the answer is the same: a booking id.
    expect(
      await inContext(appUrl, null, async (c) => {
        const own = await request(c, a, a.deal);
        const foreign = await request(c, a, b.deal);
        const none = await request(c, a, null);
        // The API's login reads no row without a context: org A's owner reads what the definer wrote, in the same transaction.
        await c.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [a.orgId, contextToken(a.owner, a.orgId)]);
        return [own !== null, foreign !== null, none !== null, await dealOfRequest(c, a, own), await dealOfRequest(c, a, foreign), await dealOfRequest(c, a, none)];
      }),
    ).toEqual([true, true, true, a.deal, null, null]);
    // Only crove_app executes it, as it does booking_request.
    const grants = await admin(async (c) =>
      (
        await c.query<{ role: string; can: boolean }>(
          `SELECT r.role, has_function_privilege(r.role, 'crove_crm.booking_request_deal(text,text,timestamptz,text,text,text,text,text,bytea,uuid)', 'EXECUTE') AS can
           FROM (VALUES ('crove_app'), ('crove_worker'), ('crove_tenant'), ('crove_definer_tenant'), ('public')) AS r(role)`,
        )
      ).rows,
    );
    expect(grants.map((g) => [g.role, g.can])).toEqual([
      ['crove_app', true],
      ['crove_worker', false],
      ['crove_tenant', false],
      ['crove_definer_tenant', false],
      ['public', false],
    ]);
  });
});

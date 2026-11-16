// SPDX-License-Identifier: AGPL-3.0-only
// The events of an app that is off wait and flow when it is back on (ADR-0053, slice c C3b), on PostgreSQL 17: a relay batch parks the events of an org whose app
// is off on the claim's own transaction, the held sweep puts them back on the outbox oldest first once the app is on, a parked event older than the expiry is dropped,
// one org's release leaves another's parked events alone, and only the worker may run the definers. Set CROVE_TEST_ADMIN_URL to a superuser URL.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { buildKernelCommands, createOrg, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { holdEvents, planHolds, releaseHeld } from '../src/outbox-hold.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('parked events of an app that is off (ADR-0053, C3b)', () => {
  const dbName = `crove_test_outboxhold_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appPool: pg.Pool;
  let workerPool: pg.Pool;
  let workerDb: Db;
  const orgs: string[] = [];

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }

  // An event of the org, pending on the outbox as a command would leave it.
  async function emit(org: string, type: string): Promise<string> {
    const id = randomUUID();
    await admin(async (c) => {
      await c.query('INSERT INTO crove_kernel.outbox_event (org_id, id, type, payload) VALUES ($1, $2, $3, $4)', [org, id, type, JSON.stringify({})]);
      await c.query('INSERT INTO crove_kernel.outbox_pending (org_id, event_id) VALUES ($1, $2)', [org, id]);
    });
    return id;
  }
  const pending = () => admin(async (c) => (await c.query<{ event_id: string }>('SELECT event_id FROM crove_kernel.outbox_pending ORDER BY seq')).rows.map((r) => r.event_id));
  const held = (org: string) => admin(async (c) => (await c.query<{ event_id: string }>('SELECT event_id FROM crove_kernel.outbox_held WHERE org_id = $1 ORDER BY seq', [org])).rows.map((r) => r.event_id));

  // One relay batch as the worker runs it: the claim, the plan, the parking, on one transaction.
  const batch = (off: ReadonlySet<string>) =>
    workerDb.transaction().execute(async (trx) => {
      const { rows } = await sql<{ org_id: string; event_id: string; type: string }>`SELECT org_id, event_id, type FROM crove_kernel.outbox_claim(100)`.execute(trx);
      const plan = await planHolds(rows, async (org, app) => !off.has(`${org}:${app}`), () => true);
      await holdEvents(trx, plan.held);
      return plan;
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
    const login = (user: string, pw: string) => {
      const u = new URL(adminUrl);
      u.username = user;
      u.password = pw;
      return u.toString();
    };
    appPool = createPool({ connectionString: login('crove_app', 'test-app-pw'), max: 2 });
    workerPool = createPool({ connectionString: login('crove_worker', 'test-worker-pw'), max: 4 });
    workerDb = createDb(workerPool);
    const rt = new Runtime(createDb(appPool), { manifests: TEST_MANIFESTS }).register({ commands: buildKernelCommands({}), queries: kernelQueries({ inboundDomain: null }) });
    for (const k of ['a', 'b']) {
      const owner = await upsertIdentity(createDb(appPool), { issuer: 'test', subject: `oh-${k}-${randomUUID()}`, email: `oh-${k}@example.com`, name: null });
      orgs.push((await createOrg(rt, { type: 'user', userId: owner, aal: 'aal1' }, `Org ${k}`)).orgId);
    }
    // The orgs' own creation events are not this test's: start from an empty outbox.
    await admin((c) => c.query('DELETE FROM crove_kernel.outbox_pending'));
  }, 120_000);

  afterAll(async () => {
    await appPool?.end();
    await workerPool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('parks the events of an off app with the claim, queues the others, and puts the parked ones back in order once the app is on', async () => {
    const [a, b] = orgs as [string, string];
    const e1 = await emit(a, 'social.post.submitted');
    const k1 = await emit(a, 'kernel.org.export_requested');
    const e2 = await emit(a, 'social.channel_option.requested');
    const other = await emit(b, 'social.post.submitted');
    const plan = await batch(new Set([`${a}:social`]));
    // The claim took all four; org A's two Social events wait and the kernel event and org B's go on.
    expect(plan.held.map((h) => h.row.event_id)).toEqual([e1, e2]);
    expect(plan.rest.map((r) => r.event_id)).toEqual([k1, other]);
    expect(await pending()).toEqual([]);
    expect(await held(a)).toEqual([e1, e2]);
    expect(await held(b)).toEqual([]);

    // Still off: the sweep leaves them, and counts them.
    expect(await releaseHeld(workerDb, async () => false)).toEqual({ released: 0, waiting: 2, pairs: 1 });
    expect(await held(a)).toEqual([e1, e2]);
    // Another org's app coming on does not move org A's events.
    expect(await releaseHeld(workerDb, async (org) => org === b)).toEqual({ released: 0, waiting: 2, pairs: 1 });
    // On: back on the outbox, oldest first, and parked no more.
    expect(await releaseHeld(workerDb, async () => true)).toEqual({ released: 2, waiting: 0, pairs: 1 });
    expect(await held(a)).toEqual([]);
    expect(await pending()).toEqual([e1, e2]);
    // The relay claims them like any other, and with the app on they are not parked again.
    const again = await batch(new Set());
    expect(again.held).toEqual([]);
    expect(again.rest.map((r) => r.event_id)).toEqual([e1, e2]);
  });

  it('parks an event once, never drops a parked event however old, and leaves an org that is not active alone', async () => {
    const a = orgs[0] as string;
    const old = await emit(a, 'social.post.submitted');
    const fresh = await emit(a, 'social.post.submitted');
    const plan = await batch(new Set([`${a}:social`]));
    await workerDb.transaction().execute((trx) => holdEvents(trx, plan.held));
    expect(await held(a)).toEqual([old, fresh]);
    // A year old and still waiting: there is no expiry.
    await admin((c) => c.query("UPDATE crove_kernel.outbox_held SET held_at = now() - interval '365 days' WHERE event_id = $1", [old]));
    expect(await releaseHeld(workerDb, async () => false)).toMatchObject({ released: 0, waiting: 2 });
    expect(await held(a)).toEqual([old, fresh]);
    // An org that is closed is neither listed nor released, whatever the app says.
    await admin((c) => c.query("UPDATE crove_kernel.tenant SET status = 'closed' WHERE org_id = $1", [a]));
    expect(await releaseHeld(workerDb, async () => true)).toEqual({ released: 0, waiting: 0, pairs: 0 });
    expect(await held(a)).toEqual([old, fresh]);
    await admin((c) => c.query("UPDATE crove_kernel.tenant SET status = 'active' WHERE org_id = $1", [a]));
    expect(await releaseHeld(workerDb, async () => true)).toMatchObject({ released: 2 });
    expect(await pending()).toEqual([old, fresh]);
    await admin((c) => c.query('DELETE FROM crove_kernel.outbox_pending'));
  });

  it('pages through every pair with parked events, so a pair whose app stays off does not hold back the ones after it', async () => {
    const [a, b] = orgs as [string, string];
    const ea = await emit(a, 'social.post.submitted');
    const eb = await emit(b, 'social.post.submitted');
    const plan = await batch(new Set([`${a}:social`, `${b}:social`]));
    expect(plan.held).toHaveLength(2);
    // Only the org that sorts last is on: its events are released whichever order the pairs come in.
    const [first, last] = [a, b].sort() as [string, string];
    expect(await releaseHeld(workerDb, async (org) => org === last)).toEqual({ released: 1, waiting: 1, pairs: 2 });
    expect(await pending()).toEqual([last === a ? ea : eb]);
    expect(await held(first)).toEqual([first === a ? ea : eb]);
    await admin((c) => c.query('DELETE FROM crove_kernel.outbox_pending'));
    await admin((c) => c.query('DELETE FROM crove_kernel.outbox_held'));
  });

  it('keeps the retention job from archiving away the day of a parked event, and lets it once it is released', async () => {
    const a = orgs[0] as string;
    const id = await emit(a, 'social.post.submitted');
    await batch(new Set([`${a}:social`]));
    const day = '2020-01-01';
    // An event of an old day, archived: the purge answers -1 while the event waits, as for one that waits for the relay.
    await admin(async (c) => {
      await c.query("ALTER TABLE crove_kernel.outbox_event DISABLE TRIGGER USER");
      await c.query("UPDATE crove_kernel.outbox_event SET created_at = '2020-01-01T10:00:00Z' WHERE org_id = $1 AND id = $2", [a, id]);
      await c.query("ALTER TABLE crove_kernel.outbox_event ENABLE TRIGGER USER");
      await c.query("INSERT INTO crove_kernel.outbox_archive (org_id, day, object_key, sha256, row_count) VALUES ($1, $2, 'k', $3, 1)", [a, day, 'a'.repeat(64)]);
    });
    const purge = () => workerDb.transaction().execute(async (trx) => (await sql<{ n: number }>`SELECT crove_kernel.outbox_archive_purge(${a}::uuid, ${day}::date, 30) AS n`.execute(trx)).rows[0]?.n);
    expect(await purge()).toBe(-1);
    await releaseHeld(workerDb, async () => true);
    await admin((c) => c.query('DELETE FROM crove_kernel.outbox_pending'));
    expect(await purge()).toBe(1);
  });

  it('lets only the worker run the definers, and refuses a malformed call', async () => {
    const fns = ['crove_kernel.outbox_hold(uuid[], uuid[], text[])', 'crove_kernel.outbox_hold_pairs(integer, uuid, text)', 'crove_kernel.outbox_release(uuid, text, integer)'];
    const grantees = await admin(async (c) =>
      (
        await c.query<{ fn: string; grantees: string[] }>(
          `SELECT f AS fn, COALESCE((SELECT array_agg(DISTINCT CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE (SELECT r.rolname FROM pg_roles r WHERE r.oid = x.grantee)::text END)
                                    FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) x WHERE x.grantee <> p.proowner), '{}'::text[]) AS grantees
           FROM unnest($1::text[]) f JOIN pg_proc p ON p.oid = f::regprocedure`,
          [fns],
        )
      ).rows,
    );
    for (const g of grantees) expect(g.grantees, g.fn).toEqual(['crove_worker']);
    await expect(appPool.query('SELECT * FROM crove_kernel.outbox_hold_pairs(10, NULL, NULL)')).rejects.toMatchObject({ code: '42501' });
    await expect(workerPool.query('SELECT crove_kernel.outbox_hold(ARRAY[]::uuid[], ARRAY[gen_random_uuid()], ARRAY[]::text[])')).rejects.toMatchObject({ code: '22023' });
    await expect(workerPool.query('SELECT crove_kernel.outbox_release(NULL, NULL, 10)')).rejects.toMatchObject({ code: '22023' });
    await expect(workerPool.query('SELECT * FROM crove_kernel.outbox_hold_pairs(10, gen_random_uuid(), NULL)')).rejects.toMatchObject({ code: '22023' });
    // The table itself is no login role's, and agents may not write it.
    await expect(workerPool.query('SELECT * FROM crove_kernel.outbox_held')).rejects.toMatchObject({ code: '42501' });
    await expect(appPool.query('SELECT * FROM crove_kernel.outbox_held')).rejects.toMatchObject({ code: '42501' });
  });
});

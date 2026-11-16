// SPDX-License-Identifier: AGPL-3.0-only
// The events of an app that is off wait and flow when it is back on (ADR-0053, slice c C3b), on PostgreSQL 17: a relay batch parks the events of an org whose app
// is off on the claim's own transaction, the held sweep puts them back on the outbox oldest first once the app is on (its cursor goes on across sweeps, and an app switched on is
// released at once for its org), one org's release leaves another's parked events alone, and the retention job drops a parked event with its day once the day is past the keep period
// (a closed org's included, many held days included), one org's release and purge never overlapping. The definers' grants are test/invariant/outbox-held-definers.db.test.ts.
// Set CROVE_TEST_ADMIN_URL to a superuser URL.
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { buildKernelCommands, createOrg, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { holdEvents, planHolds, releaseHeld, releaseHeldOfOrg } from '../src/outbox-hold.ts';
import { archiveOutbox } from '../src/outbox-retention.ts';
import { LocalArchiveStore } from '../src/worm.ts';
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
  const held = (org: string) => admin(async (c) => (await c.query<{ event_id: string }>('SELECT event_id FROM crove_kernel.outbox_held WHERE org_id = $1 ORDER BY id', [org])).rows.map((r) => r.event_id));

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

  it('parks an event once, the sweep never drops a parked event however old, and leaves an org that is not active alone', async () => {
    const a = orgs[0] as string;
    const old = await emit(a, 'social.post.submitted');
    const fresh = await emit(a, 'social.post.submitted');
    const plan = await batch(new Set([`${a}:social`]));
    await workerDb.transaction().execute((trx) => holdEvents(trx, plan.held));
    expect(await held(a)).toEqual([old, fresh]);
    // A year old and still waiting: the sweep does not expire it (the retention job does, with its day).
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

  // An event of the org on an old UTC day, as the relay would have left it parked (or pending), the way retention finds it.
  async function oldEvent(org: string, day: string, parked: boolean): Promise<string> {
    const id = await emit(org, 'social.post.submitted');
    await admin(async (c) => {
      await c.query('ALTER TABLE crove_kernel.outbox_event DISABLE TRIGGER USER');
      await c.query('UPDATE crove_kernel.outbox_event SET created_at = $3::timestamptz WHERE org_id = $1 AND id = $2', [org, id, `${day}T10:00:00Z`]);
      await c.query('ALTER TABLE crove_kernel.outbox_event ENABLE TRIGGER USER');
      if (parked) {
        await c.query('DELETE FROM crove_kernel.outbox_pending WHERE org_id = $1 AND event_id = $2', [org, id]);
        await c.query("INSERT INTO crove_kernel.outbox_held (org_id, event_id, module) VALUES ($1, $2, 'social')", [org, id]);
      }
    });
    return id;
  }
  const eventCount = (org: string) => admin(async (c) => Number((await c.query<{ n: string }>('SELECT count(*)::text AS n FROM crove_kernel.outbox_event WHERE org_id = $1', [org])).rows[0]?.n));
  const store = () => new LocalArchiveStore(mkdtempSync(join(tmpdir(), 'outbox-held-archive-')));

  it('drops a parked event with its day once the day is past the keep period, and logs how many per app and nothing of the event', async () => {
    const a = orgs[0] as string;
    await admin((c) => c.query('DELETE FROM crove_kernel.outbox_pending'));
    const parked = await oldEvent(a, '2020-01-01', true);
    const plain = await oldEvent(a, '2020-01-01', false);
    await admin((c) => c.query('DELETE FROM crove_kernel.outbox_pending WHERE event_id = $1', [plain]));
    expect(await held(a)).toEqual([parked]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const before = await eventCount(a);
      const result = await archiveOutbox(workerDb, store());
      // The parked event does not keep its day: both events of the day are archived and deleted, and its marker goes with it.
      expect(result).toMatchObject({ archived: 1, purged: 2, deferred: 0 });
      expect(await eventCount(a)).toBe(before - 2);
      expect(await held(a)).toEqual([]);
      const lines = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('[outbox-retention]'));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(`org ${a} 2020-01-01: 1 parked events of social dropped`);
      expect(lines[0]).not.toContain(parked);
    } finally {
      warn.mockRestore();
    }
  });

  it('retires the parked events of a closed org with its days, and a run with many held days purges all of them and defers none', async () => {
    const [a, b] = orgs as [string, string];
    await admin((c) => c.query('DELETE FROM crove_kernel.outbox_pending'));
    await admin((c) => c.query("UPDATE crove_kernel.tenant SET status = 'closed' WHERE org_id = $1", [a]));
    try {
      const days = Array.from({ length: 12 }, (_, i) => `2019-03-${String(i + 1).padStart(2, '0')}`);
      for (const day of days) {
        await oldEvent(a, day, true);
        await oldEvent(b, day, true);
      }
      expect((await held(a)).length).toBe(12);
      const beforeA = await eventCount(a);
      const beforeB = await eventCount(b);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        const result = await archiveOutbox(workerDb, store());
        expect(result).toMatchObject({ archived: 24, purged: 24, deferred: 0 });
      } finally {
        warn.mockRestore();
      }
      expect(await eventCount(a)).toBe(beforeA - 12);
      expect(await eventCount(b)).toBe(beforeB - 12);
      expect(await held(a)).toEqual([]);
      expect(await held(b)).toEqual([]);
    } finally {
      await admin((c) => c.query("UPDATE crove_kernel.tenant SET status = 'active' WHERE org_id = $1", [a]));
    }
  });

  it('still defers the day of an event that waits for the relay, and refuses to expire the markers of a day inside the keep period', async () => {
    const a = orgs[0] as string;
    await admin((c) => c.query('DELETE FROM crove_kernel.outbox_pending'));
    const waiting = await oldEvent(a, '2018-05-05', false);
    expect(await pending()).toEqual([waiting]);
    expect(await archiveOutbox(workerDb, store())).toMatchObject({ archived: 1, purged: 0, deferred: 1 });
    await admin((c) => c.query('DELETE FROM crove_kernel.outbox_pending'));
    expect(await archiveOutbox(workerDb, store())).toMatchObject({ purged: 1, deferred: 0 });
    // A recent day is refused by the expiry whatever its markers say.
    await expect(workerPool.query("SELECT * FROM crove_kernel.outbox_held_expire($1::uuid, current_date, 30)", [a])).rejects.toMatchObject({ code: '22023' });
  });

  it('runs one org\'s release, expiry and day purge one after the other, and a purge that follows a release keeps the released event', async () => {
    const a = orgs[0] as string;
    await admin((c) => c.query('DELETE FROM crove_kernel.outbox_pending'));
    const day = '2017-07-07';
    await oldEvent(a, day, true);
    await admin((c) => c.query("INSERT INTO crove_kernel.outbox_archive (org_id, day, object_key, sha256, row_count) VALUES ($1, $2, 'k', $3, 1) ON CONFLICT DO NOTHING", [a, day, 'b'.repeat(64)]));
    // Each of the three calls waits while another transaction holds the org's lock, and goes on when it ends: they take the same one.
    const calls: Array<[string, string]> = [
      ['outbox_release', "SELECT crove_kernel.outbox_release($1::uuid, 'social', 10)"],
      ['outbox_held_expire', `SELECT * FROM crove_kernel.outbox_held_expire($1::uuid, '${day}', 30)`],
      ['outbox_archive_purge', `SELECT crove_kernel.outbox_archive_purge($1::uuid, '${day}', 30)`],
    ];
    for (const [name, query] of calls) {
      const holder = new pg.Client({ connectionString: adminUrl });
      await holder.connect();
      try {
        await holder.query('BEGIN');
        await holder.query("SELECT pg_advisory_xact_lock(hashtextextended('crove_kernel.outbox:' || $1::text, 0))", [a]);
        let done = false;
        const run = workerPool.query(query, [a]).then(() => {
          done = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 400));
        expect(done, `${name} waits for the org's lock`).toBe(false);
        await holder.query('COMMIT');
        await run;
        expect(done).toBe(true);
      } finally {
        await holder.end();
      }
    }
    await admin((c) => c.query('DELETE FROM crove_kernel.outbox_pending'));
    await admin((c) => c.query('DELETE FROM crove_kernel.outbox_held'));
    await admin((c) => c.query('DELETE FROM crove_kernel.outbox_archive WHERE org_id = $1 AND day = $2', [a, day]));
    // A released old event is pending again: the day's purge defers it and the event stays.
    const released = await oldEvent(a, '2016-06-06', true);
    expect(await releaseHeld(workerDb, async () => true)).toMatchObject({ released: 1 });
    expect(await archiveOutbox(workerDb, store())).toMatchObject({ deferred: 1 });
    expect(await pending()).toEqual([released]);
    expect(await admin(async (c) => (await c.query('SELECT 1 FROM crove_kernel.outbox_event WHERE org_id = $1 AND id = $2', [a, released])).rowCount)).toBe(1);
    await admin((c) => c.query('DELETE FROM crove_kernel.outbox_pending'));
    expect(await archiveOutbox(workerDb, store())).toMatchObject({ purged: 1, deferred: 0 });
  });

  it('leaves a pair whose release fails for the next sweep, without holding back the pairs after it', async () => {
    const [a, b] = orgs as [string, string];
    await admin((c) => c.query('DELETE FROM crove_kernel.outbox_pending'));
    await admin((c) => c.query('DELETE FROM crove_kernel.outbox_held'));
    const ea = await emit(a, 'social.post.submitted');
    const eb = await emit(b, 'social.post.submitted');
    await batch(new Set([`${a}:social`, `${b}:social`]));
    const [first, second] = [a, b].sort() as [string, string];
    // The app answer fails the way a database error would for the first pair only.
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const flaky = async (org: string) => {
        if (org === first) throw new Error('read failed');
        return true;
      };
      expect(await releaseHeld(workerDb, flaky)).toMatchObject({ released: 1, waiting: 1, pairs: 2 });
      expect(await pending()).toEqual([second === a ? ea : eb]);
    } finally {
      err.mockRestore();
    }
    await admin((c) => c.query('DELETE FROM crove_kernel.outbox_pending'));
    await admin((c) => c.query('DELETE FROM crove_kernel.outbox_held'));
  });

  it('goes on across sweeps from where the last one stopped, wrapping to the start at the end, so no pair is left behind a page cap', async () => {
    const [a, b] = orgs as [string, string];
    await admin((c) => c.query('DELETE FROM crove_kernel.outbox_pending'));
    await admin((c) => c.query('DELETE FROM crove_kernel.outbox_held'));
    const ea = await emit(a, 'social.post.submitted');
    const eb = await emit(b, 'social.post.submitted');
    await batch(new Set([`${a}:social`, `${b}:social`]));
    const [first, second] = [a, b].sort() as [string, string];
    const seen: string[] = [];
    const cursor = { after: null as { org: string; module: string } | null };
    const limits = { pageSize: 1, maxPages: 1 };
    // One pair per page and one page per sweep. The first sweep sees the first org only, while the app is off for both.
    await releaseHeld(workerDb, async (org) => (seen.push(org), false), cursor, limits);
    expect(seen).toEqual([first]);
    // The next one goes on after it: the second org is reached and released (from the first page again it would see the first org only).
    expect(await releaseHeld(workerDb, async (org) => (seen.push(org), org === second), cursor, limits)).toMatchObject({ released: 1, pairs: 1 });
    expect(seen).toEqual([first, second]);
    // Past the last pair the cursor wraps: an empty page, then the first page again.
    expect(await releaseHeld(workerDb, async () => false, cursor, limits)).toMatchObject({ pairs: 0 });
    expect(cursor.after).toBeNull();
    expect(await releaseHeld(workerDb, async () => false, cursor, limits)).toMatchObject({ pairs: 1, waiting: 1 });
    void ea;
    void eb;
    await admin((c) => c.query('DELETE FROM crove_kernel.outbox_pending'));
    await admin((c) => c.query('DELETE FROM crove_kernel.outbox_held'));
  });

  it('puts back one org\'s parked events of an app that is on when that org switches an app on, and no other org\'s', async () => {
    const [a, b] = orgs as [string, string];
    await admin((c) => c.query('DELETE FROM crove_kernel.outbox_pending'));
    const ea = await emit(a, 'social.post.submitted');
    await emit(b, 'social.post.submitted');
    await batch(new Set([`${a}:social`, `${b}:social`]));
    expect(await releaseHeldOfOrg(workerDb, async () => false, a)).toBe(0);
    expect(await releaseHeldOfOrg(workerDb, async () => true, a)).toBe(1);
    expect(await pending()).toEqual([ea]);
    expect((await held(b)).length).toBe(1);
    await admin((c) => c.query('DELETE FROM crove_kernel.outbox_pending'));
    await admin((c) => c.query('DELETE FROM crove_kernel.outbox_held'));
  });
});

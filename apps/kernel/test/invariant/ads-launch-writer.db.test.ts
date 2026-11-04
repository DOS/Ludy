// SPDX-License-Identifier: AGPL-3.0-only
// The launch writer of running ads (W2-3, issue #2296, ADR-0043 points 2 to 5, plan docs/plan/ads-write.md sections 3.4, 7 and 9; step one of the invariant route is
// #2555): what a launch created at the platform, the guard of the launch ledger that now holds a person's stop, and the safety net that queues a lost launch
// again. Each condition is a test here, against a real PostgreSQL, in SQL where the claim is about the database and not about a command:
//   1. the table of the platform's objects (crove_ads.ad_object) is read by tenant roles, its status columns are the only ones they update, none deletes, and
//      its guard is a definer that fires for every role;
//   2. an object row is inserted by the system's record step of a launch that is running and nothing else (no person, no agent, no queued launch), with the
//      launch's tag in its name and paused; what identifies it never changes, and what the platform reported is the system's alone;
//   3. THE ACCEPTANCE LINE OF W2-3: a person's stop must not release spend that ran or is in flight. A launch that was started (launching, needs attention or
//      live) is stopped by an owner or an admin only with its commitment held to at least the earlier of what it was and today in the account's time zone, and never
//      cleared; the system, which knows what the writer did, may release it, and a launch that is live is never stopped with its commitment cleared by anyone;
//   4. crove_ads.launch_requeue, the safety net of the launch job, is the worker's alone, writes ids only, and queues a launch that waited, only for the
//      providers it is asked for and never one that is done, paused or needs a person.
// Keep this directory self-contained: import code under test, not fixtures from outside it. Set CROVE_TEST_ADMIN_URL to a superuser URL; the run creates and drops
// its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const HASH = `sha256:${'a'.repeat(64)}`;
const OBJECT_UPDATABLE = ['configured_status', 'effective_status', 'last_seen_at', 'review_reason', 'updated_at'];

const suite = ADMIN ? describe : describe.skip;

type Who = 'owner' | 'admin' | 'member' | 'viewer' | 'system';
interface Org {
  orgId: string;
  owner: string;
  admin: string;
  member: string;
  viewer: string;
}

const addDays = (day: string, days: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

suite('the launch writer of running ads (#2296, W2-3)', () => {
  const dbName = `crove_test_adswriter_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let workerUrl = '';
  let pool: pg.Pool;
  let runtime: Runtime;

  async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }
  const admin = <T>(fn: (c: pg.Client) => Promise<T>) => withClient(adminUrl, fn);
  const rows = async <T extends pg.QueryResultRow>(text: string, params: unknown[] = []) => admin(async (c) => (await c.query<T>(text, params)).rows);
  const owner = (text: string, params: unknown[] = []) => admin(async (c) => (await c.query(text, params)).rowCount);

  async function person(name: string): Promise<string> {
    const tag = randomUUID().slice(0, 8);
    return upsertIdentity(createDb(pool), { issuer: 'test', subject: `${name}-${tag}`, email: `${name}-${tag}@writer.test`, name: null });
  }
  // An org with an owner, an admin, a member and a viewer.
  async function makeOrg(): Promise<Org> {
    const ownerId = await person('owner');
    const org = await createOrg(runtime, { type: 'user', userId: ownerId, aal: 'aal1' }, `Công ty ${randomUUID().slice(0, 8)}`);
    const out: Org = { orgId: org.orgId, owner: ownerId, admin: await person('admin'), member: await person('member'), viewer: await person('viewer') };
    for (const [role, user] of [['admin', out.admin], ['member', out.member], ['viewer', out.viewer]] as const) {
      await owner(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, $3)`, [org.orgId, user, role]);
    }
    return out;
  }

  // SQL in a context of each kind, as the API's login (a person) or the worker's (the system), rolled back unless `commit`.
  async function inContext<T>(org: Org, who: Who, fn: (c: pg.Client) => Promise<T>, commit = false): Promise<T> {
    return withClient(who === 'system' ? workerUrl : appUrl, async (c) => {
      await c.query('BEGIN');
      try {
        if (who === 'system') await c.query('SELECT crove_kernel.enter_system_context($1::uuid)', [org.orgId]);
        else await c.query('SELECT crove_kernel.enter_context($1::uuid, $2::uuid)', [org[who], org.orgId]);
        const out = await fn(c);
        if (commit) await c.query('COMMIT');
        return out;
      } finally {
        await c.query('ROLLBACK').catch(() => undefined);
      }
    });
  }
  const refused = (c: pg.Client, text: string, params: unknown[], message: string) => expect(c.query(text, params)).rejects.toMatchObject({ code: '42501', message: expect.stringContaining(message) });
  const move = (c: pg.Client, org: Org, id: string, set: string) => c.query(`UPDATE crove_ads.ad_launch SET ${set} WHERE org_id = $1 AND id = $2`, [org.orgId, id]);

  // A day in a time zone as the database tells it now (the zone's own today).
  const todayIn = async (zone: string | null) => (await rows<{ d: string }>(`SELECT ((now() AT TIME ZONE $1)::date)::text AS d`, [zone ?? 'UTC']))[0]?.d as string;

  // An ad account and a launch of 100 000 a day over the days given, as the table's owner outside any context (as a definer would), in the state asked for.
  async function launch(
    org: Org,
    options: { start?: string; end?: string; zone?: string | null; state?: 'queued' | 'launching' | 'needs_attention' | 'live' | 'stopped' | 'cancelled'; step?: string | null; ageMinutes?: number; account?: string; provider?: string | null } = {},
  ) {
    const start = options.start ?? '2031-03-01';
    const end = options.end ?? '2031-03-10';
    const days = Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000) + 1;
    let account = options.account;
    if (!account) {
      const connection = randomUUID();
      account = randomUUID();
      await owner(
        `INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, scopes, connected_by) VALUES ($1, $2, 'sandbox_ads', $3, 'Thử', '{}', $4)`,
        [org.orgId, connection, `acct-${connection.slice(0, 8)}`, org.owner],
      );
      await owner(`INSERT INTO crove_ads.ad_account (org_id, id, channel_connection_id, provider, external_account_id, name, backfill_from, currency, time_zone) VALUES ($1, $2, $3, 'sandbox_ads', $4, 'Thử', '2025-10-01', 'VND', $5)`, [
        org.orgId,
        account,
        connection,
        `acct-${connection.slice(0, 8)}`,
        options.zone === undefined ? 'Asia/Ho_Chi_Minh' : options.zone,
      ]);
      if (options.provider) {
        // The write connection of the account, attached as a definer would (the guard of that column is for a person's sign-in, not for a test's setup).
        const write = randomUUID();
        await owner(`INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, scopes, connected_by) VALUES ($1, $2, $3, $4, 'Ghi', '{ads_read,ads_management}', $5)`, [
          org.orgId,
          write,
          options.provider,
          `acct-${connection.slice(0, 8)}`,
          org.owner,
        ]);
        await admin(async (c) => {
          await c.query('ALTER TABLE crove_ads.ad_account DISABLE TRIGGER write_connection_guard');
          try {
            await c.query(`UPDATE crove_ads.ad_account SET write_connection_id = $3 WHERE org_id = $1 AND id = $2`, [org.orgId, account, write]);
          } finally {
            await c.query('ALTER TABLE crove_ads.ad_account ENABLE ALWAYS TRIGGER write_connection_guard');
          }
        });
      }
    }
    const draft = randomUUID();
    await owner(`INSERT INTO crove_ads.ad_campaign_draft (org_id, id, ad_account_id, name, objective, created_by) VALUES ($1, $2, $3, 'Thử', 'traffic', $4)`, [org.orgId, draft, account, org.owner]);
    const id = randomUUID();
    const state = options.state ?? 'queued';
    const final = state === 'stopped' || state === 'cancelled';
    await owner(
      `INSERT INTO crove_ads.ad_launch (org_id, id, ad_account_id, draft_id, proposal_id, plan_hash, currency, daily_budget, start_on, end_on, amount, commit_until, created_by, state, step, finished_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'VND', '100000', $7, $8, $9, ${final ? 'NULL' : '$8'}, $10, $11, $12, ${final ? 'now()' : 'NULL'}, now() - make_interval(mins => $13), now() - make_interval(mins => $13))`,
      [org.orgId, id, account, draft, randomUUID(), HASH, start, end, String(100000 * days), org.owner, state, options.step ?? null, options.ageMinutes ?? 0],
    );
    return { id, account, draft, start, end };
  }
  // A launch of an account in the zone that is running (made by the system's moves, as the job makes them): launching, needs attention or live, for a flight that
  // started three days ago and has ten days to go in that zone.
  async function started(org: Org, state: 'launching' | 'needs_attention' | 'live', zone: string | null = 'Asia/Ho_Chi_Minh') {
    // No zone recorded, or one the database does not know, falls back to the LATEST day any zone can be on (tomorrow in UTC), so a person can release the least.
    const unknown = zone === null || zone === 'Mars/Phobos';
    const today = await todayIn(unknown ? 'UTC' : zone);
    const expected = unknown ? addDays(today, 1) : today;
    const l = await launch(org, { start: addDays(expected, -3), end: addDays(expected, 10), zone });
    await inContext(
      org,
      'system',
      async (c) => {
        await move(c, org, l.id, `state = 'launching'`);
        if (state !== 'launching') await move(c, org, l.id, `state = '${state}'`);
      },
      true,
    );
    return { ...l, today: expected };
  }
  const get = async (org: Org, id: string) =>
    (await rows<{ state: string; step: string | null; commit_until: string | null; stop_reason: string | null; finished_at: Date | null }>(`SELECT state, step, commit_until::text, stop_reason, finished_at FROM crove_ads.ad_launch WHERE org_id = $1 AND id = $2`, [org.orgId, id]))[0];
  const tagOf = async (org: Org, id: string) => (await rows<{ tag: string }>(`SELECT tag FROM crove_ads.ad_launch WHERE org_id = $1 AND id = $2`, [org.orgId, id]))[0]?.tag as string;

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
    const loginUrl = (username: string, password: string) => {
      const url = new URL(adminUrl);
      url.username = username;
      url.password = password;
      return url.toString();
    };
    appUrl = loginUrl('crove_app', 'test-app-pw');
    workerUrl = loginUrl('crove_worker', 'test-worker-pw');
    pool = createPool({ connectionString: appUrl, max: 2 });
    runtime = new Runtime(createDb(pool), { manifests: TEST_MANIFESTS }).register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: null }) });
  }, 300_000);

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('gives tenant roles the platform objects to read and their status columns to update, no delete, and holds them with a definer guard that fires for every role', async () => {
    const roles = ['crove_app', 'crove_worker', 'crove_tenant'];
    const priv = await rows<{ role: string; select: boolean; update: boolean; del: boolean; truncate: boolean }>(
      `SELECT r AS role, has_table_privilege(r, 'crove_ads.ad_object', 'SELECT') AS select, has_table_privilege(r, 'crove_ads.ad_object', 'UPDATE') AS update,
              has_table_privilege(r, 'crove_ads.ad_object', 'DELETE') AS del, has_table_privilege(r, 'crove_ads.ad_object', 'TRUNCATE') AS truncate
       FROM unnest($1::text[]) r`,
      [roles],
    );
    for (const p of priv) expect(p, p.role).toMatchObject({ select: true, update: false, del: false, truncate: false });
    const granted = await rows<{ column_name: string }>(
      `SELECT a.attname AS column_name FROM pg_attribute a WHERE a.attrelid = 'crove_ads.ad_object'::regclass AND a.attnum > 0 AND NOT a.attisdropped AND has_column_privilege('crove_tenant', a.attrelid, a.attnum, 'UPDATE') ORDER BY 1`,
    );
    expect(granted.map((g) => g.column_name)).toEqual([...OBJECT_UPDATABLE].sort());
    const guard = await rows<{ enabled: string; definer: boolean; config: string[] | null; app: boolean; worker: boolean }>(
      `SELECT t.tgenabled AS enabled, p.prosecdef AS definer, p.proconfig AS config, has_function_privilege('crove_app', p.oid, 'EXECUTE') AS app, has_function_privilege('crove_worker', p.oid, 'EXECUTE') AS worker
       FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid WHERE t.tgrelid = 'crove_ads.ad_object'::regclass AND t.tgname = 'object_guard'`,
    );
    expect(guard).toEqual([{ enabled: 'A', definer: true, config: ['search_path=pg_catalog, pg_temp'], app: false, worker: false }]);
    // The safety net is the worker's login alone.
    const requeue = await rows<{ app: boolean; worker: boolean; tenant: boolean; pub: boolean }>(
      `SELECT has_function_privilege('crove_app', f, 'EXECUTE') AS app, has_function_privilege('crove_worker', f, 'EXECUTE') AS worker, has_function_privilege('crove_tenant', f, 'EXECUTE') AS tenant,
              EXISTS (SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x WHERE p.oid = f AND x.grantee = 0) AS pub
       FROM (SELECT 'crove_ads.launch_requeue(text[], integer)'::regprocedure AS f) q`,
    );
    expect(requeue).toEqual([{ app: false, worker: true, tenant: false, pub: false }]);
  });

  it('inserts an object only as the system, for a launch that is running, with the launch\'s tag in its name and paused: no person, no queued launch, nothing else', async () => {
    const org = await makeOrg();
    const queued = await launch(org);
    const running = await started(org, 'launching');
    const tag = await tagOf(org, running.id);
    const insert = `INSERT INTO crove_ads.ad_object (org_id, ad_account_id, launch_id, slot, level, external_id, name) VALUES ($1, $2, $3, $4, $5, $6, $7)`;
    const args = (l: { id: string; account: string }, slot: string, level: string, name: string) => [org.orgId, l.account, l.id, slot, level, `ext-${randomUUID().slice(0, 8)}`, name];
    // A person (owner, admin, member, viewer) is refused, even for a running launch.
    for (const who of ['owner', 'admin', 'member', 'viewer'] as const) {
      await inContext(org, who, (c) => refused(c, insert, args(running, 'campaign', 'campaign', `Thử ${tag}`), 'ADS_OBJECT_FORBIDDEN'));
    }
    // The system is refused for a launch that has not started, and for a name without the launch's tag, another launch's tag included.
    await inContext(org, 'system', (c) => refused(c, insert, args(queued, 'campaign', 'campaign', `Thử ${tag}`), 'ADS_OBJECT_FORBIDDEN'));
    await inContext(org, 'system', (c) => refused(c, insert, args(running, 'campaign', 'campaign', 'Thử không có thẻ'), 'ADS_OBJECT_FORBIDDEN'));
    await inContext(org, 'system', (c) => refused(c, insert, args(running, 'campaign', 'campaign', 'Thử ludy:0000000000'), 'ADS_OBJECT_FORBIDDEN'));
    // Paused, and nothing the platform reported yet.
    await inContext(org, 'system', (c) =>
      refused(c, `INSERT INTO crove_ads.ad_object (org_id, ad_account_id, launch_id, slot, level, external_id, name, configured_status) VALUES ($1, $2, $3, 'campaign', 'campaign', 'x1', $4, 'archived')`, [org.orgId, running.account, running.id, `Thử ${tag}`], 'ADS_OBJECT_FORBIDDEN'),
    );
    await inContext(org, 'system', (c) =>
      refused(c, `INSERT INTO crove_ads.ad_object (org_id, ad_account_id, launch_id, slot, level, external_id, name, effective_status) VALUES ($1, $2, $3, 'campaign', 'campaign', 'x2', $4, 'ACTIVE')`, [org.orgId, running.account, running.id, `Thử ${tag}`], 'ADS_OBJECT_FORBIDDEN'),
    );
    // The account is the launch's own.
    const other = await launch(org);
    await inContext(org, 'system', (c) => refused(c, insert, [org.orgId, other.account, running.id, 'campaign', 'campaign', 'x3', `Thử ${tag}`], 'ADS_OBJECT_FORBIDDEN'));
    // The slot and the level agree, and a slot is one object of a launch.
    await inContext(org, 'system', (c) => expect(c.query(insert, args(running, 'ad_set', 'campaign', `Thử ${tag}`))).rejects.toMatchObject({ code: '23514', constraint: 'ad_object_slot_ck' }));
    await inContext(org, 'system', (c) => expect(c.query(insert, args(running, 'creative_4', 'creative', `Thử ${tag}`))).rejects.toMatchObject({ code: '23514', constraint: 'ad_object_slot_ck' }));
    // The system's record step: accepted, and the row is in the launch's account and entity.
    await inContext(
      org,
      'system',
      async (c) => {
        await c.query(insert, args(running, 'campaign', 'campaign', `Thử ${tag}`));
        await c.query(insert, args(running, 'ad_set', 'ad_set', `Thử ${tag} set`));
      },
      true,
    );
    const made = await rows<{ slot: string; configured_status: string; legal_entity_id: string | null }>(`SELECT slot, configured_status, legal_entity_id FROM crove_ads.ad_object WHERE org_id = $1 AND launch_id = $2 ORDER BY slot`, [org.orgId, running.id]);
    expect(made.map((m) => [m.slot, m.configured_status])).toEqual([['ad_set', 'paused'], ['campaign', 'paused']]);
    expect(made.every((m) => m.legal_entity_id !== null)).toBe(true);
    // A slot twice is refused by the key, and a platform id twice for the account and level too.
    await inContext(org, 'system', (c) => expect(c.query(insert, args(running, 'campaign', 'campaign', `Thử ${tag}`))).rejects.toMatchObject({ code: '23505', constraint: 'ad_object_slot_uq' }));
    // An object the platform made while a concurrent run stopped the launch is tracked all the same: a launch that is stopped (or failed, or waiting for a person) takes
    // it, one that was cancelled before it started does not.
    await inContext(org, 'system', (c) => move(c, org, running.id, `state = 'stopped', commit_until = NULL, stop_reason = 'switch_off'`), true);
    await inContext(org, 'system', (c) => c.query(insert, args(running, 'creative_1', 'creative', `Thử ${tag} creative 1`)), true);
    const cancelled = await launch(org, { state: 'cancelled' });
    await inContext(org, 'system', (c) => refused(c, insert, args(cancelled, 'campaign', 'campaign', `Thử ${tag}`), 'ADS_OBJECT_FORBIDDEN'));
    await inContext(org, 'system', async (c) => refused(c, insert, args(cancelled, 'campaign', 'campaign', `Thử ${await tagOf(org, cancelled.id)}`), 'ADS_OBJECT_FORBIDDEN'));
    // A context of another org cannot write this org's rows: row security refuses it, the system's included.
    const stranger = await makeOrg();
    await inContext(stranger, 'owner', (c) => refused(c, insert, args(running, 'creative_1', 'creative', `Thử ${tag} creative 1`), 'row-level security'));
    await inContext(stranger, 'system', (c) => refused(c, insert, args(running, 'creative_1', 'creative', `Thử ${tag} creative 1`), 'row-level security'));
  });

  it('lets the system set what the platform reported and what Ludy set, and no person; what identifies the object never changes; nobody deletes one', async () => {
    const org = await makeOrg();
    const running = await started(org, 'launching');
    const tag = await tagOf(org, running.id);
    await inContext(
      org,
      'system',
      (c) => c.query(`INSERT INTO crove_ads.ad_object (org_id, ad_account_id, launch_id, slot, level, external_id, name) VALUES ($1, $2, $3, 'campaign', 'campaign', 'obj-1', $4)`, [org.orgId, running.account, running.id, `Thử ${tag}`]),
      true,
    );
    const update = (set: string) => `UPDATE crove_ads.ad_object SET ${set} WHERE org_id = $1 AND launch_id = $2`;
    // A person changes nothing: the status columns are granted, the guard refuses.
    for (const who of ['owner', 'admin', 'member', 'viewer'] as const) {
      await inContext(org, who, (c) => refused(c, update(`effective_status = 'ACTIVE'`), [org.orgId, running.id], 'ADS_OBJECT_FORBIDDEN'));
      await inContext(org, who, (c) => refused(c, update(`configured_status = 'archived'`), [org.orgId, running.id], 'ADS_OBJECT_FORBIDDEN'));
    }
    // What identifies it, and what was sent, is not even granted to update.
    for (const column of ['external_id', 'name', 'slot', 'level', 'launch_id', 'ad_account_id']) {
      await inContext(org, 'system', (c) => expect(c.query(update(`${column} = ${column}`), [org.orgId, running.id])).rejects.toMatchObject({ code: '42501' }));
    }
    // The table's owner, outside any context, is held by the guard on the identity columns too.
    await expect(owner(update(`name = 'đổi tên'`), [org.orgId, running.id])).rejects.toMatchObject({ code: '42501', message: expect.stringContaining('ADS_OBJECT_FORBIDDEN') });
    // The system reports the platform's state and archives.
    await inContext(org, 'system', (c) => c.query(update(`effective_status = 'PAUSED', review_reason = NULL, last_seen_at = now()`), [org.orgId, running.id]), true);
    await inContext(org, 'system', (c) => c.query(update(`configured_status = 'archived'`), [org.orgId, running.id]), true);
    expect((await rows<{ configured_status: string; effective_status: string }>(`SELECT configured_status, effective_status FROM crove_ads.ad_object WHERE org_id = $1 AND launch_id = $2`, [org.orgId, running.id]))[0]).toEqual({ configured_status: 'archived', effective_status: 'PAUSED' });
    // Nothing un-pauses at this slice: the status column holds paused or archived and no other.
    await inContext(org, 'system', (c) => expect(c.query(update(`configured_status = 'active'`), [org.orgId, running.id])).rejects.toMatchObject({ code: '23514' }));
    // No person and no worker deletes an object; the purge does, with the account.
    for (const who of ['owner', 'system'] as const) {
      await inContext(org, who, (c) => expect(c.query(`DELETE FROM crove_ads.ad_object WHERE org_id = $1`, [org.orgId])).rejects.toMatchObject({ code: '42501' }));
    }
    await owner(`DELETE FROM crove_ads.ad_account WHERE org_id = $1 AND id = $2`, [org.orgId, running.account]);
    expect((await rows<{ n: string }>(`SELECT count(*)::text AS n FROM crove_ads.ad_object WHERE org_id = $1`, [org.orgId]))[0]?.n).toBe('0');
  });

  // THE ACCEPTANCE LINE OF W2-3.
  it('a person\'s stop must not release spend that ran or is in flight: an owner or an admin stops a started launch with its commitment held to at least the earlier of what it was and today, never cleared', async () => {
    const org = await makeOrg();
    for (const state of ['launching', 'needs_attention', 'live'] as const) {
      for (const who of ['owner', 'admin'] as const) {
        const l = await started(org, state);
        const stop = (set: string) => `UPDATE crove_ads.ad_launch SET state = 'stopped', ${set} WHERE org_id = $1 AND id = $2`;
        const label = `${who} stops ${state}`;
        // Never cleared, and never earlier than today in the account's zone: not yesterday, not the first day of the flight.
        await inContext(org, who, (c) => refused(c, stop('commit_until = NULL'), [org.orgId, l.id], 'ADS_LAUNCH_FORBIDDEN'), false);
        await inContext(org, who, (c) => refused(c, stop(`commit_until = '${addDays(l.today, -1)}'`), [org.orgId, l.id], 'ADS_LAUNCH_FORBIDDEN'), false);
        await inContext(org, who, (c) => refused(c, stop(`commit_until = '${l.start}'`), [org.orgId, l.id], 'ADS_LAUNCH_FORBIDDEN'), false);
        // Nor later than it was (the commitment only shortens).
        await inContext(org, who, (c) => refused(c, stop(`commit_until = '${addDays(l.end, 1)}'`), [org.orgId, l.id], 'ADS_LAUNCH_FORBIDDEN'), false);
        expect(await get(org, l.id), label).toMatchObject({ state, commit_until: l.end });
        // Today, held: the budget of the day that is running is still committed, and what comes after is released.
        await inContext(org, who, (c) => move(c, org, l.id, `state = 'stopped', commit_until = '${l.today}', stop_reason = 'stopped_by_person'`), true);
        expect(await get(org, l.id), label).toMatchObject({ state: 'stopped', commit_until: l.today, stop_reason: 'stopped_by_person' });
      }
    }
  });

  it('holds that line in every time zone, and in one the database does not know: the earlier of what it was and the account\'s own today', async () => {
    const org = await makeOrg();
    // Kiritimati is a day ahead of most of the world, Pago Pago a day behind, and no zone, or a name the database does not know, falls back to the latest day any zone can
    // be on (tomorrow in UTC): releasing a day that ran in a zone ahead of UTC is what the person must not be able to do.
    for (const zone of ['Pacific/Kiritimati', 'Pacific/Pago_Pago', 'UTC', 'America/Los_Angeles', null, 'Mars/Phobos']) {
      const l = await started(org, 'launching', zone);
      const stop = (value: string) => `UPDATE crove_ads.ad_launch SET state = 'stopped', commit_until = '${value}' WHERE org_id = $1 AND id = $2`;
      await inContext(org, 'owner', (c) => refused(c, stop(addDays(l.today, -1)), [org.orgId, l.id], 'ADS_LAUNCH_FORBIDDEN'));
      await inContext(org, 'owner', (c) => c.query(stop(l.today), [org.orgId, l.id]), true);
      expect(await get(org, l.id), String(zone)).toMatchObject({ state: 'stopped', commit_until: l.today });
    }
  });

  it('keeps what the system already shortened: a person cannot end earlier than the commitment stands, and can end where it stands', async () => {
    const org = await makeOrg();
    const l = await started(org, 'launching');
    // The system, which knows what ran, shortens the commitment to two days ago (no move).
    const earlier = addDays(l.today, -2);
    await inContext(org, 'system', (c) => move(c, org, l.id, `commit_until = '${earlier}'`), true);
    const stop = (value: string) => `UPDATE crove_ads.ad_launch SET state = 'stopped', commit_until = '${value}' WHERE org_id = $1 AND id = $2`;
    // Earlier than that is releasing days that ran; later than that is not shortening.
    await inContext(org, 'admin', (c) => refused(c, stop(addDays(earlier, -1)), [org.orgId, l.id], 'ADS_LAUNCH_FORBIDDEN'));
    await inContext(org, 'admin', (c) => refused(c, stop(l.today), [org.orgId, l.id], 'ADS_LAUNCH_FORBIDDEN'));
    await inContext(org, 'admin', (c) => c.query(stop(earlier), [org.orgId, l.id]), true);
    expect(await get(org, l.id)).toMatchObject({ state: 'stopped', commit_until: earlier });
  });

  it('leaves the release to the system, which knows what the writer did: it may stop a launching or a waiting launch with nothing committed, never a live one', async () => {
    const org = await makeOrg();
    const stopSystem = (c: pg.Client, id: string, set: string) => move(c, org, id, `state = 'stopped', ${set}`);
    const launching = await started(org, 'launching');
    await inContext(org, 'system', (c) => stopSystem(c, launching.id, `commit_until = NULL, stop_reason = 'switch_off'`), true);
    expect(await get(org, launching.id)).toMatchObject({ state: 'stopped', commit_until: null, stop_reason: 'switch_off' });
    const waiting = await started(org, 'needs_attention');
    await inContext(org, 'system', (c) => stopSystem(c, waiting.id, `commit_until = NULL, stop_reason = 'account_off'`), true);
    expect(await get(org, waiting.id)).toMatchObject({ state: 'stopped', commit_until: null });
    // A live launch ran: whoever stops it keeps what ran committed, the system too.
    const live = await started(org, 'live');
    await inContext(org, 'system', (c) => refused(c, `UPDATE crove_ads.ad_launch SET state = 'stopped', commit_until = NULL WHERE org_id = $1 AND id = $2`, [org.orgId, live.id], 'ADS_LAUNCH_FORBIDDEN'));
    await inContext(org, 'system', (c) => stopSystem(c, live.id, `commit_until = '${addDays(live.today, -1)}'`), true);
    expect(await get(org, live.id)).toMatchObject({ state: 'stopped', commit_until: addDays(live.today, -1) });
    // A queued launch has started nothing, so a person's cancel releases its whole commitment, as before.
    const queued = await launch(org);
    await inContext(org, 'owner', (c) => move(c, org, queued.id, `state = 'cancelled'`), true);
    expect(await get(org, queued.id)).toMatchObject({ state: 'cancelled', commit_until: null });
  });

  it('queues a launch that waited again, with ids only, for the providers asked and for the worker alone; never one that is done, paused or needs a person', async () => {
    const org = await makeOrg();
    const providers = ['sandboxwrite_ads'];
    const waiting = await launch(org, { ageMinutes: 10, provider: 'sandboxwrite_ads' });
    const halfWay = await launch(org, { ageMinutes: 10, provider: 'sandboxwrite_ads', state: 'launching', step: 'ad_set' });
    const notYet = await launch(org, { ageMinutes: 1, provider: 'sandboxwrite_ads' });
    const paused = await launch(org, { ageMinutes: 10, provider: 'sandboxwrite_ads', state: 'launching', step: 'paused' });
    const needs = await launch(org, { ageMinutes: 10, provider: 'sandboxwrite_ads', state: 'needs_attention' });
    const cancelled = await launch(org, { ageMinutes: 10, provider: 'sandboxwrite_ads', state: 'cancelled' });
    const live = await launch(org, { ageMinutes: 10, provider: 'sandboxwrite_ads', state: 'live' });
    const otherProvider = await launch(org, { ageMinutes: 10, provider: 'metawrite_ads' });
    const noWrite = await launch(org, { ageMinutes: 10 });
    const call = (list: string[], url = workerUrl) => withClient(url, async (c) => (await c.query<{ n: number }>(`SELECT crove_ads.launch_requeue($1::text[], 100) AS n`, [list])).rows[0]?.n);
    // Only the worker's login runs it.
    await expect(call(providers, appUrl)).rejects.toMatchObject({ code: '42501' });
    expect(await call(['metawrite_ads', 'nothing'])).toBe(1);
    expect(await call(providers)).toBe(2);
    const events = await rows<{ type: string; payload: Record<string, unknown> }>(`SELECT type, payload FROM crove_kernel.outbox_event WHERE org_id = $1 AND type = 'ads.launch.queued' ORDER BY id`, [org.orgId]);
    // Ids only: the launch and its account, never a name, an amount or a token.
    for (const e of events) expect(Object.keys(e.payload).sort()).toEqual(['adAccountId', 'launchId']);
    const queued = events.map((e) => e.payload.launchId);
    expect(queued).toEqual(expect.arrayContaining([waiting.id, halfWay.id, otherProvider.id]));
    for (const l of [notYet, paused, needs, cancelled, live, noWrite]) expect(queued).not.toContain(l.id);
    expect(events).toHaveLength(3);
    // Each event is in the relay's queue, so the relay turns it into a job.
    const pending = await rows<{ n: string }>(`SELECT count(*)::text AS n FROM crove_kernel.outbox_pending p JOIN crove_kernel.outbox_event e ON e.org_id = p.org_id AND e.id = p.event_id WHERE e.org_id = $1 AND e.type = 'ads.launch.queued'`, [org.orgId]);
    expect(pending[0]?.n).toBe('3');
    // An empty list asks for nothing.
    expect(await call([])).toBe(0);
  });
});

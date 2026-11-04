// SPDX-License-Identifier: AGPL-3.0-only
// The stop of a launch and the wind-down of what it made (W2-4a, issue #2296, ADR-0043 points 4 and 7a, plan docs/plan/ads-write.md sections 3.6 and 10; step one of the
// invariant route is #2574). Each condition is a test here, against a real PostgreSQL:
//   1. THE ACCEPTANCE LINE OF W2-3, THROUGH THE COMMANDS THAT STOP: a person's stop must not release spend that ran or is in flight. An owner or an admin who stops a
//      launch that has started (launching, needs attention or live) with `ads.launch.stop` leaves its commitment at the earlier of what it was and today in the account's
//      own time zone, never cleared, in every state, for both roles, in every zone (and none, and one the database does not know, where today is the latest day any zone
//      can be on), and after the system shortened it; the switch-off, the account switch-off, the kill switch and the disconnect of an account stop the launches of their
//      scope the same way and leave the others alone; a member, a viewer or an agent cannot stop one, a launch that has not started is cancelled and not stopped, and a
//      stopped one is not stopped again;
//   2. every stop writes the event `ads.pause.queued` (ids only), which the pause job and the sweep's re-queue are fed by;
//   3. the wind-down of a stopped launch (`wound_down_at`, `wind_down_tries`, `wind_down_next_at`, `wind_down_code`) is the system's alone: never set at insert, never by a
//      person or an agent (no column grant, and the guard), only for a stopped launch, and never reopened once done or given up on;
//   4. the worker-only definers that claim, settle and re-queue a wind-down (`wind_down_take`, `wind_down_settle`, `wind_down_requeue`): worker only, a lease and a counted
//      try, one run at a time, a settlement that is done, due again or given up with a code, and a safety net that queues only what is open, due and not leased;
//   5. `crove_ads.launch_today`, the one definition of today that the guard and the commands share.
// Keep this directory self-contained: import code under test, not fixtures from outside it. Set CROVE_TEST_ADMIN_URL to a superuser URL; the run creates and drops its
// own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { adsCommands, adsManifest, adsQueries } from '@crove/mod-ads';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const HASH = `sha256:${'a'.repeat(64)}`;

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
// The zones the acceptance line is tested in: the earliest and the latest on earth, UTC, a zone behind it, none, and one the database does not know.
const ZONES: ReadonlyArray<string | null> = ['Pacific/Kiritimati', 'Pacific/Pago_Pago', 'UTC', 'America/Los_Angeles', null, 'Mars/Phobos'];

suite('the stop of a launch and the wind-down of what it made (#2296, W2-4a)', () => {
  const dbName = `crove_test_adsstop_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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
    return upsertIdentity(createDb(pool), { issuer: 'test', subject: `${name}-${tag}`, email: `${name}-${tag}@stop.test`, name: null });
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
  const actorOf = (org: Org, who: 'owner' | 'admin' | 'member' | 'viewer') => ({ type: 'user' as const, userId: org[who], aal: 'aal1' as const });

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
  const refused = (c: pg.Client, text: string, params: unknown[], message?: string) =>
    expect(c.query(text, params)).rejects.toMatchObject({ code: '42501', ...(message ? { message: expect.stringContaining(message) } : {}) });
  const move = (c: pg.Client, org: Org, id: string, set: string) => c.query(`UPDATE crove_ads.ad_launch SET ${set} WHERE org_id = $1 AND id = $2`, [org.orgId, id]);

  // A day in a time zone as the database tells it now (the zone's own today).
  const todayIn = async (zone: string | null) => (await rows<{ d: string }>(`SELECT ((now() AT TIME ZONE $1)::date)::text AS d`, [zone ?? 'UTC']))[0]?.d as string;
  // What a person's stop may leave: the zone's own today, or, for no zone or one the database does not know, the latest day any zone can be on (tomorrow in UTC).
  const expectedToday = async (zone: string | null) => (zone === null || zone === 'Mars/Phobos' ? addDays(await todayIn('UTC'), 1) : todayIn(zone));

  async function account(org: Org, zone: string | null = 'Asia/Ho_Chi_Minh'): Promise<string> {
    const connection = randomUUID();
    const id = randomUUID();
    await owner(`INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, scopes, connected_by) VALUES ($1, $2, 'sandbox_ads', $3, 'Thử', '{}', $4)`, [
      org.orgId,
      connection,
      `acct-${connection.slice(0, 8)}`,
      org.owner,
    ]);
    await owner(`INSERT INTO crove_ads.ad_account (org_id, id, channel_connection_id, provider, external_account_id, name, backfill_from, currency, time_zone) VALUES ($1, $2, $3, 'sandbox_ads', $4, 'Thử', '2025-10-01', 'VND', $5)`, [
      org.orgId,
      id,
      connection,
      `acct-${connection.slice(0, 8)}`,
      zone,
    ]);
    return id;
  }
  // A launch of 100 000 a day over the days given, as the table's owner outside any context (as a definer would), queued.
  async function launch(org: Org, accountId: string, start: string, end: string, ageMinutes = 0) {
    const days = Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000) + 1;
    const draft = randomUUID();
    await owner(`INSERT INTO crove_ads.ad_campaign_draft (org_id, id, ad_account_id, name, objective, created_by) VALUES ($1, $2, $3, 'Thử', 'traffic', $4)`, [org.orgId, draft, accountId, org.owner]);
    const id = randomUUID();
    await owner(
      `INSERT INTO crove_ads.ad_launch (org_id, id, ad_account_id, draft_id, proposal_id, plan_hash, currency, daily_budget, start_on, end_on, amount, commit_until, created_by, state, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'VND', '100000', $7, $8, $9, $8, $10, 'queued', now() - make_interval(mins => $11), now() - make_interval(mins => $11))`,
      [org.orgId, id, accountId, draft, randomUUID(), HASH, start, end, String(100000 * days), org.owner, ageMinutes],
    );
    return id;
  }
  // A launch that has started in an account of the zone, made by the system's moves as the job makes them: launching, needs attention or live, for a flight that started three
  // days ago and has ten days to go in that zone.
  async function started(org: Org, state: 'launching' | 'needs_attention' | 'live', zone: string | null = 'Asia/Ho_Chi_Minh', accountId?: string) {
    const today = await expectedToday(zone);
    const acct = accountId ?? (await account(org, zone));
    const id = await launch(org, acct, addDays(today, -3), addDays(today, 10));
    await inContext(
      org,
      'system',
      async (c) => {
        await move(c, org, id, `state = 'launching'`);
        if (state !== 'launching') await move(c, org, id, `state = '${state}'`);
      },
      true,
    );
    return { id, account: acct, today };
  }
  const get = async (org: Org, id: string) =>
    (
      await rows<{ state: string; step: string | null; commit_until: string | null; stop_reason: string | null; finished_at: Date | null; wound_down_at: Date | null; wind_down_tries: number; wind_down_next_at: Date | null; wind_down_code: string | null }>(
        `SELECT state, step, commit_until::text, stop_reason, finished_at, wound_down_at, wind_down_tries, wind_down_next_at, wind_down_code FROM crove_ads.ad_launch WHERE org_id = $1 AND id = $2`,
        [org.orgId, id],
      )
    )[0];
  // The events ads.pause.queued of a launch, and what they carry.
  const pauseEvents = (org: Org, id: string) => rows<{ payload: Record<string, unknown> }>(`SELECT payload FROM crove_kernel.outbox_event WHERE org_id = $1 AND type = 'ads.pause.queued' AND payload ->> 'launchId' = $2`, [org.orgId, id]);
  const stop = (org: Org, who: 'owner' | 'admin' | 'member' | 'viewer', launchId: string) => runtime.execute('ads.launch.stop', { launchId }, { actor: actorOf(org, who), orgId: org.orgId });

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
    pool = createPool({ connectionString: appUrl, max: 4 });
    runtime = new Runtime(createDb(pool), { manifests: [...TEST_MANIFESTS, adsManifest.tables] }).register({ commands: [...kernelCommands, ...adsCommands], queries: [...kernelQueries({ inboundDomain: null }), ...adsQueries] });
  }, 300_000);

  afterAll(async () => {
    await pool?.end();
    if (!adminUrl) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  describe('a person’s stop through ads.launch.stop (the acceptance line)', () => {
    it('keeps the commitment at the earlier of what it was and today in the account’s zone, never cleared, in every state, for an owner and an admin, in every zone', async () => {
      const org = await makeOrg();
      for (const zone of ZONES) {
        for (const state of ['launching', 'needs_attention', 'live'] as const) {
          for (const who of ['owner', 'admin'] as const) {
            const l = await started(org, state, zone);
            const before = await get(org, l.id);
            expect(before, `${zone}/${state}`).toMatchObject({ state, commit_until: addDays(l.today, 10) });
            const answer = await stop(org, who, l.id);
            expect(answer, `${zone}/${state}/${who}`).toEqual({ launchId: l.id, state: 'stopped', commitUntil: l.today });
            const after = await get(org, l.id);
            expect(after, `${zone}/${state}/${who}`).toMatchObject({ state: 'stopped', stop_reason: 'stopped', commit_until: l.today });
            expect(after?.finished_at).toBeInstanceOf(Date);
            // The day it stops on is not released: the budget of today still counts, and the days after it are free.
            expect(after?.commit_until).not.toBeNull();
            // The objects at the platform are paused from the queue: the event carries ids and nothing else, and the wind-down is open.
            const events = await pauseEvents(org, l.id);
            expect(events.map((e) => Object.keys(e.payload).sort()), `${zone}/${state}/${who}`).toEqual([['adAccountId', 'launchId']]);
            expect(after).toMatchObject({ wound_down_at: null, wind_down_tries: 0, wind_down_next_at: null, wind_down_code: null });
          }
        }
      }
    });

    it('never moves a commitment the system already shortened later: the stop leaves the earlier of the two', async () => {
      const org = await makeOrg();
      const l = await started(org, 'live');
      // The system, which knows what the writer did, shortened it to five days ago.
      await inContext(org, 'system', (c) => move(c, org, l.id, `commit_until = '${addDays(l.today, -5)}'`), true);
      expect(await stop(org, 'owner', l.id)).toEqual({ launchId: l.id, state: 'stopped', commitUntil: addDays(l.today, -5) });
      expect(await get(org, l.id)).toMatchObject({ state: 'stopped', commit_until: addDays(l.today, -5) });
    });

    it('is refused for a member, a viewer and an agent, and changes nothing', async () => {
      const org = await makeOrg();
      const l = await started(org, 'launching');
      for (const who of ['member', 'viewer'] as const) await expect(stop(org, who, l.id), who).rejects.toMatchObject({ status: 403 });
      await expect(runtime.execute('ads.launch.stop', { launchId: l.id }, { actor: { type: 'agent', agentId: randomUUID(), onBehalfOf: org.owner } as never, orgId: org.orgId })).rejects.toMatchObject({ status: 403 });
      expect(await get(org, l.id)).toMatchObject({ state: 'launching', commit_until: addDays(l.today, 10) });
      expect(await pauseEvents(org, l.id)).toEqual([]);
    });

    it('stops a launch that has started and nothing else: a queued one is cancelled, a stopped one is not stopped again, an unknown one is not found', async () => {
      const org = await makeOrg();
      const acct = await account(org);
      const queued = await launch(org, acct, addDays(await todayIn('Asia/Ho_Chi_Minh'), 1), addDays(await todayIn('Asia/Ho_Chi_Minh'), 5));
      await expect(stop(org, 'owner', queued)).rejects.toMatchObject({ status: 409, code: 'ADS_LAUNCH_NOT_RUNNING' });
      expect((await get(org, queued))?.state).toBe('queued');
      const l = await started(org, 'live');
      await stop(org, 'owner', l.id);
      await expect(stop(org, 'admin', l.id)).rejects.toMatchObject({ status: 409, code: 'ADS_LAUNCH_NOT_RUNNING' });
      expect(await pauseEvents(org, l.id)).toHaveLength(1);
      await expect(stop(org, 'owner', randomUUID())).rejects.toMatchObject({ status: 404 });
    });
  });

  describe('the stops of the org and of an account', () => {
    it('stop the started launches of their scope with the same rule, and leave the others alone: the switch-off, the kill switch, the account’s switch-off and its disconnect', async () => {
      const org = await makeOrg();
      const today = await todayIn('Asia/Ho_Chi_Minh');
      const cases: Array<{ command: string; who: 'owner' | 'admin'; input: (acct: string) => Record<string, unknown>; reason: string; scope: 'org' | 'account' }> = [
        { command: 'ads.write.disable', who: 'owner', input: () => ({}), reason: 'switch_off', scope: 'org' },
        { command: 'ads.pause_all', who: 'admin', input: () => ({}), reason: 'launches_blocked', scope: 'org' },
        { command: 'ads.account.disable_write', who: 'owner', input: (acct) => ({ adAccountId: acct }), reason: 'account_off', scope: 'account' },
        { command: 'ads.account.disconnect', who: 'admin', input: (acct) => ({ adAccountId: acct }), reason: 'disconnected', scope: 'account' },
      ];
      for (const c of cases) {
        const mine = await started(org, 'live');
        const needs = await started(org, 'needs_attention');
        const other = await started(org, 'launching');
        const answer = (await runtime.execute(c.command, c.input(mine.account), { actor: actorOf(org, c.who), orgId: org.orgId })) as Record<string, unknown>;
        // The org's stops take every started launch; an account's only its account's (the others' launches are untouched).
        const stopped = c.scope === 'org' ? [mine, needs, other] : [mine];
        const untouched = c.scope === 'org' ? [] : [needs, other];
        for (const l of stopped) {
          expect(await get(org, l.id), `${c.command}`).toMatchObject({ state: 'stopped', stop_reason: c.reason, commit_until: today });
          expect((await pauseEvents(org, l.id)).map((e) => Object.keys(e.payload).sort()), c.command).toEqual([['adAccountId', 'launchId']]);
        }
        for (const l of untouched) {
          expect(await get(org, l.id), `${c.command}`).toMatchObject({ state: l === needs ? 'needs_attention' : 'launching', commit_until: addDays(today, 10) });
          expect(await pauseEvents(org, l.id), c.command).toEqual([]);
        }
        if (c.command === 'ads.pause_all') expect(answer).toMatchObject({ launchesBlocked: true, paused: 3 });
        // Leave the others stopped too, so the next case starts from launches of its own.
        for (const l of untouched) await stop(org, 'owner', l.id);
      }
    });
  });

  describe('the wind-down columns', () => {
    it('are never set at insert, never written by a person or an agent, and only for a stopped launch', async () => {
      const org = await makeOrg();
      const acct = await account(org);
      const draft = randomUUID();
      await owner(`INSERT INTO crove_ads.ad_campaign_draft (org_id, id, ad_account_id, name, objective, created_by) VALUES ($1, $2, $3, 'Thử', 'traffic', $4)`, [org.orgId, draft, acct, org.owner]);
      for (const column of ['wound_down_at = now()', 'wind_down_tries = 1', 'wind_down_next_at = now()', `wind_down_code = 'age'`]) {
        const [name, value] = column.split(' = ') as [string, string];
        await inContext(org, 'owner', (c) =>
          refused(
            c,
            `INSERT INTO crove_ads.ad_launch (org_id, ad_account_id, draft_id, proposal_id, plan_hash, currency, daily_budget, start_on, end_on, amount, created_by, ${name})
             VALUES ($1, $2, $3, $4, $5, 'VND', '100000', '2031-03-01', '2031-03-02', '200000', $6, ${value})`,
            [org.orgId, acct, draft, randomUUID(), HASH, org.owner],
          ),
        );
      }
      const l = await started(org, 'live');
      await stop(org, 'owner', l.id);
      for (const who of ['owner', 'admin', 'member', 'viewer'] as const) {
        for (const set of ['wound_down_at = now()', 'wind_down_tries = 3', 'wind_down_next_at = now()', `wind_down_code = 'age'`]) {
          await inContext(org, who, (c) => refused(c, `UPDATE crove_ads.ad_launch SET ${set} WHERE org_id = $1 AND id = $2`, [org.orgId, l.id]));
        }
      }
      // The system's own write goes through the definers; a raw update of the columns by the system is refused for a launch that is not stopped.
      const live = await started(org, 'live');
      await inContext(org, 'system', (c) => refused(c, `UPDATE crove_ads.ad_launch SET wind_down_tries = 1 WHERE org_id = $1 AND id = $2`, [org.orgId, live.id]));
      expect(await get(org, l.id)).toMatchObject({ wound_down_at: null, wind_down_tries: 0, wind_down_code: null });
    });

    it('cannot be changed together with the state, the step or the commitment, and a wound-down or given-up launch is never reopened', async () => {
      const org = await makeOrg();
      const l = await started(org, 'live');
      await stop(org, 'owner', l.id);
      // With a change of the commitment in the same statement: refused, whoever the system is.
      await inContext(org, 'system', (c) => refused(c, `UPDATE crove_ads.ad_launch SET wind_down_tries = 1, commit_until = '${addDays(l.today, -9)}' WHERE org_id = $1 AND id = $2`, [org.orgId, l.id]));
      await inContext(org, 'system', async (c) => {
        const took = await c.query<{ tries: number | null }>(`SELECT crove_ads.wind_down_take($1::uuid, $2::uuid, 600) AS tries`, [org.orgId, l.id]);
        expect(took.rows[0]?.tries).toBe(1);
        expect((await c.query<{ settled: boolean }>(`SELECT crove_ads.wind_down_settle($1::uuid, $2::uuid, true, NULL, NULL) AS settled`, [org.orgId, l.id])).rows[0]?.settled).toBe(true);
      }, true);
      expect(await get(org, l.id)).toMatchObject({ wind_down_tries: 1, wind_down_next_at: null, wind_down_code: null });
      expect((await get(org, l.id))?.wound_down_at).toBeInstanceOf(Date);
      // Done: it is never reopened, by a raw update or by the definers.
      await inContext(org, 'system', (c) => refused(c, `UPDATE crove_ads.ad_launch SET wound_down_at = NULL WHERE org_id = $1 AND id = $2`, [org.orgId, l.id]));
      await inContext(org, 'system', async (c) => {
        expect((await c.query(`SELECT crove_ads.wind_down_take($1::uuid, $2::uuid, 600) AS tries`, [org.orgId, l.id])).rows[0]?.tries).toBeNull();
        expect((await c.query(`SELECT crove_ads.wind_down_settle($1::uuid, $2::uuid, false, NULL, 'age') AS settled`, [org.orgId, l.id])).rows[0]?.settled).toBe(false);
      });
    });
  });

  describe('the worker-only definers of the wind-down', () => {
    it('are the worker’s alone: the app login and the tenant roles are refused', async () => {
      const org = await makeOrg();
      const l = await started(org, 'live');
      await stop(org, 'owner', l.id);
      const calls: Array<[string, unknown[]]> = [
        [`SELECT crove_ads.wind_down_take($1::uuid, $2::uuid, 600)`, [org.orgId, l.id]],
        [`SELECT crove_ads.wind_down_settle($1::uuid, $2::uuid, true, NULL, NULL)`, [org.orgId, l.id]],
        [`SELECT crove_ads.wind_down_requeue(10)`, []],
      ];
      for (const [text, params] of calls) {
        await inContext(org, 'owner', (c) => refused(c, text, params));
        await withClient(appUrl, (c) => refused(c, text, params));
      }
      const privileges = await rows<{ app: boolean; worker: boolean; tenant: boolean; pub: boolean; definer: boolean; config: string[] | null }>(
        `SELECT has_function_privilege('crove_app', p.oid, 'EXECUTE') AS app, has_function_privilege('crove_worker', p.oid, 'EXECUTE') AS worker, has_function_privilege('crove_tenant', p.oid, 'EXECUTE') AS tenant,
                EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x WHERE x.grantee = 0) AS pub, p.prosecdef AS definer, p.proconfig AS config
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'crove_ads' AND p.proname IN ('wind_down_take', 'wind_down_settle', 'wind_down_requeue') ORDER BY p.proname`,
      );
      expect(privileges).toHaveLength(3);
      for (const p of privileges) expect(p).toEqual({ app: false, worker: true, tenant: false, pub: false, definer: true, config: ['search_path=pg_catalog, pg_temp'] });
    });

    it('claim a stopped launch with a lease and a counted try, one run at a time, and settle it done, due again or given up with a code', async () => {
      const org = await makeOrg();
      const l = await started(org, 'live');
      // Not stopped yet: nothing to take.
      await inContext(org, 'system', async (c) => expect((await c.query(`SELECT crove_ads.wind_down_take($1::uuid, $2::uuid, 600) AS tries`, [org.orgId, l.id])).rows[0]?.tries).toBeNull());
      await stop(org, 'owner', l.id);
      await inContext(
        org,
        'system',
        async (c) => {
          expect((await c.query(`SELECT crove_ads.wind_down_take($1::uuid, $2::uuid, 600) AS tries`, [org.orgId, l.id])).rows[0]?.tries).toBe(1);
          // Leased: a second run finds it held.
          expect((await c.query(`SELECT crove_ads.wind_down_take($1::uuid, $2::uuid, 600) AS tries`, [org.orgId, l.id])).rows[0]?.tries).toBeNull();
        },
        true,
      );
      const leased = await get(org, l.id);
      expect(leased).toMatchObject({ wind_down_tries: 1, wound_down_at: null, wind_down_code: null });
      expect(Date.parse(String(leased?.wind_down_next_at))).toBeGreaterThan(Date.now() + 500_000);
      // Due again at a time the settlement names: not leased any more, so the next run takes it and counts the second try.
      await inContext(
        org,
        'system',
        async (c) => {
          expect((await c.query(`SELECT crove_ads.wind_down_settle($1::uuid, $2::uuid, false, now() - interval '1 second', NULL) AS settled`, [org.orgId, l.id])).rows[0]?.settled).toBe(true);
          expect((await c.query(`SELECT crove_ads.wind_down_take($1::uuid, $2::uuid, 600) AS tries`, [org.orgId, l.id])).rows[0]?.tries).toBe(2);
          // Given up: a code, no next time, never reopened.
          expect((await c.query(`SELECT crove_ads.wind_down_settle($1::uuid, $2::uuid, false, NULL, 'token_refused') AS settled`, [org.orgId, l.id])).rows[0]?.settled).toBe(true);
          expect((await c.query(`SELECT crove_ads.wind_down_take($1::uuid, $2::uuid, 600) AS tries`, [org.orgId, l.id])).rows[0]?.tries).toBeNull();
        },
        true,
      );
      expect(await get(org, l.id)).toMatchObject({ wind_down_tries: 2, wound_down_at: null, wind_down_next_at: null, wind_down_code: 'token_refused' });
      // A code is lower case letters and underscores, and done and a code do not go together.
      const m = await started(org, 'live');
      await stop(org, 'owner', m.id);
      await inContext(org, 'system', async (c) => {
        await expect(c.query(`SELECT crove_ads.wind_down_settle($1::uuid, $2::uuid, true, NULL, 'age')`, [org.orgId, m.id])).rejects.toMatchObject({ message: expect.stringContaining('ADS_WIND_DOWN_INVALID') });
      });
      await inContext(org, 'system', async (c) => {
        await expect(c.query(`SELECT crove_ads.wind_down_settle($1::uuid, $2::uuid, false, NULL, 'No Good')`, [org.orgId, m.id])).rejects.toMatchObject({ code: '23514' });
      });
    });

    it('queue the event again for a stopped launch that is open, due and not leased, and for no other, ids only', async () => {
      const org = await makeOrg();
      const open = await started(org, 'live');
      const leased = await started(org, 'live');
      const done = await started(org, 'live');
      const gaveUp = await started(org, 'live');
      const live = await started(org, 'live');
      for (const l of [open, leased, done, gaveUp]) await stop(org, 'owner', l.id);
      await inContext(
        org,
        'system',
        async (c) => {
          await c.query(`SELECT crove_ads.wind_down_take($1::uuid, $2::uuid, 600)`, [org.orgId, leased.id]);
          await c.query(`SELECT crove_ads.wind_down_settle($1::uuid, $2::uuid, true, NULL, NULL)`, [org.orgId, done.id]);
          await c.query(`SELECT crove_ads.wind_down_settle($1::uuid, $2::uuid, false, NULL, 'no_token')`, [org.orgId, gaveUp.id]);
        },
        true,
      );
      // A stop made a moment ago is the event's own to carry: only one that has waited a minute is queued again. The stops' own events are counted first.
      const own = async (id: string) => (await pauseEvents(org, id)).length;
      const before = Object.fromEntries(await Promise.all([open, leased, done, gaveUp, live].map(async (l) => [l.id, await own(l.id)])));
      await withClient(workerUrl, (c) => c.query(`SELECT crove_ads.wind_down_requeue(1000)`));
      for (const l of [open, leased, done, gaveUp, live]) expect(await own(l.id), l.id).toBe(before[l.id]);
      // Put the stop back past the minute (the table's owner, outside any context, with the guard off for the statement as the tests of the ledger do).
      await admin(async (c) => {
        await c.query('ALTER TABLE crove_ads.ad_launch DISABLE TRIGGER launch_guard');
        try {
          await c.query(`UPDATE crove_ads.ad_launch SET updated_at = now() - interval '5 minutes' WHERE org_id = $1`, [org.orgId]);
        } finally {
          await c.query('ALTER TABLE crove_ads.ad_launch ENABLE ALWAYS TRIGGER launch_guard');
        }
      });
      const queued = await withClient(workerUrl, async (c) => (await c.query<{ n: number }>(`SELECT crove_ads.wind_down_requeue(100) AS n`)).rows[0]?.n);
      expect(queued).toBeGreaterThanOrEqual(1);
      expect(await own(open.id)).toBe((before[open.id] as number) + 1);
      for (const l of [leased, done, gaveUp, live]) expect(await own(l.id), l.id).toBe(before[l.id]);
      const events = await rows<{ payload: Record<string, unknown> }>(`SELECT payload FROM crove_kernel.outbox_event WHERE org_id = $1 AND type = 'ads.pause.queued' AND payload ->> 'launchId' = $2`, [org.orgId, open.id]);
      for (const e of events) expect(Object.keys(e.payload).sort()).toEqual(['adAccountId', 'launchId']);
    });
  });

  describe('crove_ads.launch_today', () => {
    it('is the zone’s own today, and tomorrow in UTC where there is no zone or the database does not know the name', async () => {
      for (const zone of ZONES) {
        const got = (await rows<{ d: string }>(`SELECT crove_ads.launch_today($1)::text AS d`, [zone]))[0]?.d;
        expect(got, String(zone)).toBe(await expectedToday(zone));
      }
    });
  });
});

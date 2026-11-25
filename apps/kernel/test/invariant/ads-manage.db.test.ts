// SPDX-License-Identifier: AGPL-3.0-only
// The changes of a running ad (W4, issue #3835, ADR-0043 points 1, 2, 5 and 9, plan docs/plan/ads-write.md sections 3.1, 3.3, 3.4 and 3.6): a row per requested change of a
// live launch's objects (a pause, a resume, an archive, a lower or raised daily budget, a shorter or longer schedule). Each condition is a test here, against a real
// PostgreSQL, in SQL where the claim is about the database and not about a command:
//   1. tenant roles read the table and update its state columns only; none deletes or truncates; the guard is a definer that fires for every role; the helpers (the hold, the
//      requeue) are no login role's;
//   2. an INSERT is made by a signed-in owner or admin for a reducing change (a pause, an archive, a lower budget, a shorter schedule) of a live launch and an object it
//      recorded, with the values it moves from equal to what the launch holds (ADS_MANAGE_STALE), and by nothing else: no member, no viewer, no system, no table's owner in the
//      system's context, no one who is not in the org; the shape holds whoever writes (a "lower" cannot raise);
//   3. what can start or raise spend (a resume, a raise, an extension) is inserted only inside the execution of the approved proposal of its own command that names this
//      launch, this object and these values and the largest amount the plan can spend with them, with running ads on and launches not blocked; a pause needs neither switch;
//   4. an UPDATE is the system's settlement of a queued change (applied, failed, unclear), or an owner's, an admin's or the system's cancel of one the job never begun; a
//      settled change never changes; the stamps (the day it was applied, the time) are the database's; nothing identifying a change ever changes; nothing deletes one;
//   5. one change of a family at a time while it waits for the platform;
//   6. the commitment never drops before the platform confirms it (crove_ads.launch_hold, read by crove_ads.launch_commitments): a lower budget or a shorter schedule releases
//      nothing until it is applied, a raise or an extension still queued or unclear is held as an upper bound, a failed or cancelled one is released, and an archived ad set or
//      campaign stops committing at the day it was applied.
// Keep this directory self-contained: import code under test, not fixtures from outside it. Set CROVE_TEST_ADMIN_URL to a superuser URL; the run creates and drops its own
// database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '@ludy/db';
import { migrate } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import { Runtime } from '@ludy/kernel-runtime';
import { adsCommands, adsManifest, adsQueries } from '@ludy/mod-ads';
import { enterUser } from './fixtures/context-token.ts';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';
import { createDbClient, createDbPool, resolveDbIdentifiers, setActiveRolePasswords, type DbIdentifiers } from './fixtures/db-identifiers.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const HASH = `sha256:${'a'.repeat(64)}`;
const STATE_COLUMNS = ['code', 'settled_at', 'settled_on', 'state', 'updated_at'];
const ZONE = 'Asia/Ho_Chi_Minh';

const suite = ADMIN ? describe : describe.skip;

type Who = 'owner' | 'admin' | 'member' | 'viewer' | 'system';
interface Org {
  orgId: string;
  owner: string;
  admin: string;
  member: string;
  viewer: string;
}
interface Rig {
  org: Org;
  launch: string;
  account: string;
  ids: { campaign: string; ad_set: string; ad_1: string };
  start: string;
  end: string;
}
// What an INSERT of a change names (the rest is the guard's).
interface Change {
  kind: string;
  slot?: string;
  level?: string;
  objectId?: string;
  fromBudget?: string | null;
  toBudget?: string | null;
  fromEndOn?: string | null;
  toEndOn?: string | null;
  proposalId?: string | null;
}

const addDays = (day: string, days: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

suite('the changes of a running ad (#3835, W4)', () => {
  const dbName = `crove_test_adsmanage_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let dbIds: DbIdentifiers | undefined;
  let appUrl = '';
  let workerUrl = '';
  let pool: pg.Pool;
  let runtime: Runtime;
  let today = '';
  const D = (n: number) => addDays(today, n);

  async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = createDbClient({ connectionString: url }, dbIds);
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
    return upsertIdentity(createDb(pool), { issuer: 'test', subject: `${name}-${tag}`, email: `${name}-${tag}@manage.test`, name: null });
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
        else await enterUser(c, org[who], org.orgId);
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

  // The switches as an owner's context leaves them.
  const switches = (org: Org, account: string, set: { write?: boolean; blocked?: boolean; accountOn?: boolean }) =>
    inContext(
      org,
      'owner',
      async (c) => {
        await c.query('INSERT INTO crove_ads.ad_org_setting (org_id) VALUES ($1) ON CONFLICT DO NOTHING', [org.orgId]);
        if (set.write !== undefined || set.blocked !== undefined) {
          await c.query(`UPDATE crove_ads.ad_org_setting SET write_enabled = COALESCE($2, write_enabled), launches_blocked = COALESCE($3, launches_blocked) WHERE org_id = $1`, [org.orgId, set.write ?? null, set.blocked ?? null]);
        }
        if (set.accountOn !== undefined) await c.query(`UPDATE crove_ads.ad_account SET write_enabled = $3 WHERE org_id = $1 AND id = $2`, [org.orgId, account, set.accountOn]);
      },
      true,
    );

  // A live launch of 100 000 a day that began three days ago and ends in ten days (fourteen days, 1 400 000 at most), in an account in Vietnam's zone, with the campaign, the
  // ad set and one ad recorded; running ads on for the org and the account, launches not blocked.
  async function rig(): Promise<Rig> {
    const org = await makeOrg();
    const connection = randomUUID();
    const account = randomUUID();
    await owner(`INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, scopes, connected_by) VALUES ($1, $2, 'sandbox_ads', $3, 'Thử', '{}', $4)`, [org.orgId, connection, `acct-${connection.slice(0, 8)}`, org.owner]);
    await owner(`INSERT INTO crove_ads.ad_account (org_id, id, channel_connection_id, provider, external_account_id, name, backfill_from, currency, time_zone) VALUES ($1, $2, $3, 'sandbox_ads', $4, 'Thử', '2025-10-01', 'VND', $5)`, [org.orgId, account, connection, `acct-${connection.slice(0, 8)}`, ZONE]);
    await switches(org, account, { write: true, blocked: false, accountOn: true });
    const draft = randomUUID();
    await owner(`INSERT INTO crove_ads.ad_campaign_draft (org_id, id, ad_account_id, name, objective, created_by) VALUES ($1, $2, $3, 'Thử', 'traffic', $4)`, [org.orgId, draft, account, org.owner]);
    const launch = randomUUID();
    const start = D(-3);
    const end = D(10);
    await owner(
      `INSERT INTO crove_ads.ad_launch (org_id, id, ad_account_id, draft_id, proposal_id, plan_hash, currency, daily_budget, start_on, end_on, amount, commit_until, created_by, state)
       VALUES ($1, $2, $3, $4, $5, $6, 'VND', '100000', $7, $8, '1400000', $8, $9, 'queued')`,
      [org.orgId, launch, account, draft, randomUUID(), HASH, start, end, org.owner],
    );
    await inContext(org, 'system', (c) => c.query(`UPDATE crove_ads.ad_launch SET state = 'launching', step = 'campaign' WHERE org_id = $1 AND id = $2`, [org.orgId, launch]), true);
    const tag = (await rows<{ tag: string }>(`SELECT tag FROM crove_ads.ad_launch WHERE org_id = $1 AND id = $2`, [org.orgId, launch]))[0]?.tag as string;
    const ids = { campaign: `cmp-${launch.slice(0, 8)}`, ad_set: `set-${launch.slice(0, 8)}`, ad_1: `ad1-${launch.slice(0, 8)}` };
    for (const [slot, level] of [['campaign', 'campaign'], ['ad_set', 'ad_set'], ['ad_1', 'ad']] as const) {
      await owner(`INSERT INTO crove_ads.ad_object (org_id, ad_account_id, launch_id, slot, level, external_id, name) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [org.orgId, account, launch, slot, level, ids[slot], `Thử ${tag} ${slot}`]);
    }
    // Live: the activation's own rule is not what this file tests (its tests are in the launch's invariants), so the table's owner puts the row there with the guard of the
    // launch set aside for that one statement, as a backfill would.
    await admin(async (c) => {
      await c.query('BEGIN');
      try {
        await c.query('ALTER TABLE crove_ads.ad_launch DISABLE TRIGGER launch_guard');
        expect((await c.query(`UPDATE crove_ads.ad_launch SET state = 'live', step = 'live' WHERE org_id = $1 AND id = $2`, [org.orgId, launch])).rowCount).toBe(1);
        await c.query('ALTER TABLE crove_ads.ad_launch ENABLE ALWAYS TRIGGER launch_guard');
        const on = await c.query(`SELECT tgenabled::text AS t FROM pg_trigger WHERE tgrelid = 'crove_ads.ad_launch'::regclass AND tgname = 'launch_guard'`);
        expect(on.rows).toEqual([{ t: 'A' }]);
        await c.query('COMMIT');
      } catch (e) {
        await c.query('ROLLBACK');
        throw e;
      }
    });
    return { org, launch, account, ids, start, end };
  }

  // The INSERT of a change as the statement the commands make.
  const defaults = (r: Rig, change: Change): [string, unknown[]] => {
    const slot = change.slot ?? (change.kind === 'budget_lower' || change.kind === 'budget_raise' || change.kind === 'schedule_shorten' || change.kind === 'schedule_extend' ? 'ad_set' : 'campaign');
    const level = change.level ?? (slot === 'campaign' ? 'campaign' : slot === 'ad_set' ? 'ad_set' : 'ad');
    const objectId = change.objectId ?? (slot === 'campaign' ? r.ids.campaign : slot === 'ad_set' ? r.ids.ad_set : r.ids.ad_1);
    return [
      `INSERT INTO crove_ads.ad_manage_change (org_id, ad_account_id, launch_id, kind, slot, level, object_id, from_budget, to_budget, from_end_on, to_end_on, proposal_id, requested_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
      [r.org.orgId, r.account, r.launch, change.kind, slot, level, objectId, change.fromBudget ?? null, change.toBudget ?? null, change.fromEndOn ?? null, change.toEndOn ?? null, change.proposalId ?? null, r.org.owner],
    ];
  };
  const LOWER: Change = { kind: 'budget_lower', fromBudget: '100000', toBudget: '60000' };
  const SHORTEN = (r: Rig): Change => ({ kind: 'schedule_shorten', fromEndOn: r.end, toEndOn: D(5) });
  const RAISE: Change = { kind: 'budget_raise', fromBudget: '100000', toBudget: '150000' };
  const EXTEND = (r: Rig): Change => ({ kind: 'schedule_extend', fromEndOn: r.end, toEndOn: D(20) });
  const RESUME: Change = { kind: 'resume', slot: 'ad_1' };

  // A reducing change as an owner's or an admin's own command makes it, committed; answers its id.
  async function request(r: Rig, change: Change, who: 'owner' | 'admin' = 'owner'): Promise<string> {
    const [text, params] = defaults(r, change);
    return inContext(r.org, who, async (c) => (await c.query<{ id: string }>(text, params)).rows[0]?.id as string, true);
  }
  // A lower budget asked behind an unclear change of the family, as the table's owner makes it when the guard (as the commands) refuses a person's (ADS_MANAGE_UNCLEAR): these tests
  // set up a hold that has an unclear change and a later lower budget under it, which they accept whichever path puts the row there (#3898).
  async function requestBehindUnclear(r: Rig, change: Change): Promise<string> {
    return request(r, change).catch(async (error: unknown) => {
      if (!String((error as { message?: string }).message).includes('ADS_MANAGE_UNCLEAR')) throw error;
      const [text, params] = defaults(r, change);
      return admin(async (c) => (await c.query<{ id: string }>(text, params)).rows[0]?.id as string);
    });
  }
  // The system's settlement of a change (the record step of the job), committed.
  const settle = (r: Rig, id: string, state: 'applied' | 'failed' | 'unclear', code: string | null = null) =>
    inContext(r.org, 'system', (c) => c.query(`UPDATE crove_ads.ad_manage_change SET state = $3, code = $4 WHERE org_id = $1 AND id = $2`, [r.org.orgId, id, state, code]), true);
  const get = async (r: Rig, id: string) =>
    (await rows<{ state: string; code: string | null; settled_on: string | null; settled_at: Date | null; requested_by: string; proposal_id: string | null; family: string }>(`SELECT state, code, settled_on::text, settled_at, requested_by, proposal_id, family FROM crove_ads.ad_manage_change WHERE org_id = $1 AND id = $2`, [r.org.orgId, id]))[0];
  const hold = async (r: Rig) => (await rows<{ daily_budget: string; end_on: string }>(`SELECT daily_budget::text, end_on::text FROM crove_ads.launch_hold($1, $2)`, [r.org.orgId, r.launch]))[0];
  const committed = (r: Rig) =>
    inContext(r.org, 'owner', async (c) => (await c.query<{ daily_budget: string; commit_until: string }>(`SELECT daily_budget, commit_until::text FROM crove_ads.launch_commitments('VND', $1::date, $2::date) WHERE ad_account_id = $3 ORDER BY start_on DESC, commit_until DESC`, [D(-30), D(300), r.account])).rows[0]);

  // The execution of an approved proposal, the way the approval runs it: a proposal of the command, approved by the person in context, decided in this very transaction,
  // and the INSERT of the change inside it. `commit` keeps both.
  async function approved<T>(r: Rig, change: Change, over: { command?: string; payload?: Record<string, unknown>; status?: string; decidedBy?: string; amount?: string; commit?: boolean; who?: 'owner' | 'admin' } = {}): Promise<T> {
    const command = over.command ?? { resume: 'ads.object.resume', budget_raise: 'ads.budget.raise', schedule_extend: 'ads.schedule.extend' }[change.kind as 'resume' | 'budget_raise' | 'schedule_extend'];
    const days = (end: string) => Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${r.start}T00:00:00Z`)) / 86_400_000) + 1;
    const amount =
      over.amount ??
      String(change.kind === 'budget_raise' ? Number(change.toBudget) * days(r.end) : change.kind === 'schedule_extend' ? 100000 * days(change.toEndOn as string) : 100000 * days(r.end));
    const slot = change.slot ?? 'ad_set';
    const payload = { launchId: r.launch, adAccountId: r.account, slot, amount, ...(change.toBudget ? { toBudget: change.toBudget } : {}), ...(change.toEndOn ? { toEndOn: change.toEndOn } : {}), ...over.payload };
    return admin(async (c) => {
      await c.query('BEGIN');
      try {
        await enterUser(c, r.org[over.who ?? 'owner'], r.org.orgId);
        await c.query(
          `INSERT INTO crove_kernel.proposal (org_id, kind, command, status, title, payload, eligible_approvers, authors, decided_by, decided_at, executed_command_id)
           VALUES ($1, 'ads.manage', $2, $3::text, 'Thử', $4::jsonb, ARRAY[]::uuid[], '[]'::jsonb, CASE WHEN $3::text = 'pending' THEN NULL ELSE $5::uuid END, CASE WHEN $3::text = 'pending' THEN NULL ELSE now() END, CASE WHEN $3::text = 'approved' THEN gen_random_uuid() ELSE NULL END)`,
          [r.org.orgId, command, over.status ?? 'approved', JSON.stringify(payload), over.decidedBy ?? r.org[over.who ?? 'owner']],
        );
        const [text, params] = defaults(r, change);
        const out = (await c.query(text, params)).rows[0] as T;
        if (over.commit) await c.query('COMMIT');
        return out;
      } finally {
        await c.query('ROLLBACK').catch(() => undefined);
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
    dbIds = await resolveDbIdentifiers(adminUrl);
    await setActiveRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' }, dbIds);
    const loginUrl = (username: string, password: string) => {
      const url = new URL(adminUrl);
      url.username = dbIds ? dbIds.roleName(username) : username;
      url.password = password;
      return url.toString();
    };
    appUrl = loginUrl('crove_app', 'test-app-pw');
    workerUrl = loginUrl('crove_worker', 'test-worker-pw');
    pool = createDbPool({ connectionString: appUrl, max: 4 }, dbIds);
    runtime = new Runtime(createDb(pool), { manifests: [...TEST_MANIFESTS, adsManifest.tables] }).register({ commands: [...kernelCommands, ...adsCommands], queries: [...kernelQueries({ inboundDomain: null }), ...adsQueries] });
    today = (await rows<{ d: string }>(`SELECT ((now() AT TIME ZONE $1)::date)::text AS d`, [ZONE]))[0]?.d as string;
  }, 300_000);

  afterAll(async () => {
    await pool?.end();
    if (!adminUrl) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('gives tenant roles the table to read and its state columns to update, no delete, holds it with a definer guard that fires for every role, and keeps the helpers from every login', async () => {
    const roles = ['crove_app', 'crove_worker', 'crove_tenant'];
    const priv = await rows<{ role: string; select: boolean; update: boolean; del: boolean; truncate: boolean }>(
      `SELECT r AS role, has_table_privilege(r, 'crove_ads.ad_manage_change', 'SELECT') AS select, has_table_privilege(r, 'crove_ads.ad_manage_change', 'UPDATE') AS update,
              has_table_privilege(r, 'crove_ads.ad_manage_change', 'DELETE') AS del, has_table_privilege(r, 'crove_ads.ad_manage_change', 'TRUNCATE') AS truncate
       FROM unnest($1::text[]) r`,
      [roles],
    );
    for (const p of priv) expect(p, p.role).toMatchObject({ select: true, update: false, del: false, truncate: false });
    const granted = await rows<{ column_name: string }>(
      `SELECT a.attname AS column_name FROM pg_attribute a WHERE a.attrelid = 'crove_ads.ad_manage_change'::regclass AND a.attnum > 0 AND NOT a.attisdropped AND has_column_privilege('crove_tenant', a.attrelid, a.attnum, 'UPDATE') ORDER BY 1`,
    );
    expect(granted.map((g) => g.column_name)).toEqual(STATE_COLUMNS);
    // The guard: a trigger for insert and update, enabled for every role (a replica role does not skip it), of a definer with a pinned search path that no login role runs.
    const guard = await rows<{ enabled: string; definer: boolean; config: string[] | null; app: boolean; worker: boolean; events: number }>(
      `SELECT t.tgenabled AS enabled, p.prosecdef AS definer, p.proconfig AS config, has_function_privilege('crove_app', p.oid, 'EXECUTE') AS app, has_function_privilege('crove_worker', p.oid, 'EXECUTE') AS worker, t.tgtype::int AS events
       FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid WHERE t.tgrelid = 'crove_ads.ad_manage_change'::regclass AND t.tgname = 'manage_change_guard'`,
    );
    expect(guard).toMatchObject([{ enabled: 'A', definer: true, config: ['search_path=pg_catalog, pg_temp'], app: false, worker: false }]);
    // Row level security is on and forced, with the legal-entity scope RESTRICTIVE as the ledger's.
    const rls = await rows<{ on: boolean; forced: boolean }>(`SELECT relrowsecurity AS on, relforcerowsecurity AS forced FROM pg_class WHERE oid = 'crove_ads.ad_manage_change'::regclass`);
    expect(rls[0]?.on).toBe(true);
    const policies = await rows<{ policyname: string; permissive: string }>(`SELECT policyname, permissive FROM pg_policies WHERE schemaname = 'crove_ads' AND tablename = 'ad_manage_change' ORDER BY policyname`);
    expect(policies.find((p) => p.policyname === 'le_scope')).toMatchObject({ permissive: 'RESTRICTIVE' });
    // Every helper is a definer with a pinned search path; the hold and the guard are no login role's, the requeue is the worker's alone, what a plan is judged against is the
    // app's and the worker's.
    const fns = await rows<{ sig: string; definer: boolean; config: string[] | null; app: boolean; worker: boolean; tenant: boolean; pub: boolean }>(
      `SELECT p.oid::regprocedure::text AS sig, p.prosecdef AS definer, p.proconfig AS config, has_function_privilege('crove_app', p.oid, 'EXECUTE') AS app, has_function_privilege('crove_worker', p.oid, 'EXECUTE') AS worker,
              has_function_privilege('crove_tenant', p.oid, 'EXECUTE') AS tenant, EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x WHERE x.grantee = 0) AS pub
       FROM pg_proc p
       WHERE p.oid = ANY (ARRAY[to_regprocedure('crove_ads.launch_hold(uuid, uuid)'), to_regprocedure('crove_ads.manage_change_guard()'), to_regprocedure('crove_ads.manage_requeue(text[], integer)'),
                                to_regprocedure('crove_ads.launch_commitments_except(text, date, date, uuid)'), to_regprocedure('crove_ads.launch_commitments(text, date, date)'),
                                to_regprocedure('crove_ads.launch_commitments_of(text, date, date, uuid)'), to_regprocedure('crove_ads.launch_commitments_pick(text, date, date, uuid, uuid)')]::oid[])`,
    );
    expect(fns).toHaveLength(7);
    const by = (name: string) => fns.find((f) => f.sig.startsWith(name));
    for (const f of fns) expect(f, f.sig).toMatchObject({ definer: true, config: ['search_path=pg_catalog, pg_temp'], tenant: false, pub: false });
    expect(by('crove_ads.launch_hold')).toMatchObject({ app: false, worker: false });
    expect(by('crove_ads.manage_change_guard')).toMatchObject({ app: false, worker: false });
    expect(by('crove_ads.manage_requeue')).toMatchObject({ app: false, worker: true });
    expect(by('crove_ads.launch_commitments_except')).toMatchObject({ app: true, worker: true });
    expect(by('crove_ads.launch_commitments(')).toMatchObject({ app: true, worker: true });
    expect(by('crove_ads.launch_commitments_of')).toMatchObject({ app: true, worker: true });
    // The one body behind them is nobody's but the definers'.
    expect(by('crove_ads.launch_commitments_pick')).toMatchObject({ app: false, worker: false });
    // The requeue refuses a login that is not the worker's, whatever it asks.
    await withClient(appUrl, async (c) => {
      await expect(c.query(`SELECT crove_ads.manage_requeue(ARRAY['sandboxwrite_ads'], 10)`)).rejects.toMatchObject({ code: '42501' });
    });
  });

  it('lets only a signed-in owner or admin insert a reducing change, and refuses a member, a viewer, the system, the table’s owner in the system’s context and a stranger, writing nothing', async () => {
    const r = await rig();
    for (const who of ['member', 'viewer'] as const) {
      const [text, params] = defaults(r, { kind: 'pause' });
      await inContext(r.org, who, (c) => refused(c, text, params, 'ADS_MANAGE_FORBIDDEN'));
    }
    // The system is no person: the writer of the job's settlement does not ask for changes.
    {
      const [text, params] = defaults(r, { kind: 'pause' });
      await inContext(r.org, 'system', (c) => refused(c, text, params, 'ADS_MANAGE_FORBIDDEN'));
      // The table's owner (a superuser here) in the system's context is held too: the guard fires for every role.
      await admin(async (c) => {
        await c.query('BEGIN');
        try {
          await c.query('SELECT crove_kernel.enter_system_context($1::uuid)', [r.org.orgId]);
          await refused(c, text, params, 'ADS_MANAGE_FORBIDDEN');
        } finally {
          await c.query('ROLLBACK').catch(() => undefined);
        }
      });
    }
    // A person who is not in the org cannot even enter its context, so no statement of theirs reaches the table.
    const stranger = await person('stranger');
    await withClient(appUrl, async (c) => {
      await c.query('BEGIN');
      await expect(enterUser(c, stranger, r.org.orgId)).rejects.toBeTruthy();
      await c.query('ROLLBACK').catch(() => undefined);
    });
    expect((await rows<{ n: string }>(`SELECT count(*)::text AS n FROM crove_ads.ad_manage_change WHERE org_id = $1`, [r.org.orgId]))[0]?.n).toBe('0');
    // An owner and an admin do: each kind that only reduces or stops spend, for the objects the launch recorded.
    const made = [
      await request(r, { kind: 'pause', slot: 'ad_1' }, 'owner'),
      await request(r, { kind: 'archive', slot: 'campaign' }, 'admin'),
      await request(r, LOWER, 'owner'),
      await request(r, SHORTEN(r), 'admin'),
    ];
    for (const [i, id] of made.entries()) {
      expect(await get(r, id), String(i)).toMatchObject({ state: 'queued', code: null, settled_on: null, settled_at: null, proposal_id: null });
    }
    // Who asked is the person in context, whatever the statement said.
    const [text, params] = defaults(r, { kind: 'pause', slot: 'ad_set' });
    const id = await inContext(r.org, 'admin', async (c) => (await c.query<{ id: string }>(text, params)).rows[0]?.id as string, true);
    expect((await get(r, id))?.requested_by).toBe(r.org.admin);
  });

  it('refuses a change that is not queued at insert, that names a proposal when it needs none, a launch that is not live, an object the launch did not record or an id that is not its own', async () => {
    const r = await rig();
    const attempt = (change: Change, who: 'owner' | 'admin' = 'owner', message = 'ADS_MANAGE_FORBIDDEN') => {
      const [text, params] = defaults(r, change);
      return inContext(r.org, who, (c) => refused(c, text, params, message));
    };
    // The state, the code and the stamps are never the writer's: not settled at insert.
    for (const [column, value] of [['state', "'applied'"], ['code', "'X'"], ['settled_on', "'2030-01-01'"], ['settled_at', 'now()']] as const) {
      await inContext(r.org, 'owner', (c) =>
        expect(
          c.query(`INSERT INTO crove_ads.ad_manage_change (org_id, ad_account_id, launch_id, kind, slot, level, object_id, requested_by, ${column}) VALUES ($1, $2, $3, 'pause', 'campaign', 'campaign', $4, $5, ${value})`, [r.org.orgId, r.account, r.launch, r.ids.campaign, r.org.owner]),
          column,
        ).rejects.toMatchObject({ code: expect.stringMatching(/^(42501|23514)$/) }),
      );
    }
    // A pause names no proposal: it needs none.
    await attempt({ kind: 'pause', proposalId: randomUUID() });
    // An object the launch did not record, a platform id that is not the recorded one, a level that is not the slot's, an ad slot the launch has no ad for.
    await attempt({ kind: 'pause', slot: 'ad_2', level: 'ad', objectId: 'ad2-x' });
    await attempt({ kind: 'pause', slot: 'campaign', level: 'campaign', objectId: 'cmp-somebody-elses' });
    await attempt({ kind: 'pause', slot: 'ad_set', level: 'ad_set', objectId: r.ids.campaign });
    // A launch that is not live takes no change (a pause is the one that also fits a launch that needs attention); the writer's states and the final ones take none.
    for (const state of ['queued', 'launching', 'stopped', 'cancelled', 'failed', 'needs_attention']) {
      const other = await rig();
      await admin(async (c) => {
        await c.query('BEGIN');
        try {
          await c.query('ALTER TABLE crove_ads.ad_launch DISABLE TRIGGER launch_guard');
          await c.query(`UPDATE crove_ads.ad_launch SET state = $3::text, finished_at = CASE WHEN $3::text IN ('stopped', 'cancelled', 'failed') THEN now() ELSE NULL END, commit_until = CASE WHEN $3::text = 'cancelled' THEN NULL ELSE commit_until END WHERE org_id = $1 AND id = $2`, [other.org.orgId, other.launch, state]);
          await c.query('ALTER TABLE crove_ads.ad_launch ENABLE ALWAYS TRIGGER launch_guard');
          await c.query('COMMIT');
        } catch (e) {
          await c.query('ROLLBACK');
          await c.query('ALTER TABLE crove_ads.ad_launch ENABLE ALWAYS TRIGGER launch_guard');
          throw e;
        }
      });
      const [text, params] = defaults(other, LOWER);
      await inContext(other.org, 'owner', (c) => refused(c, text, params, 'ADS_MANAGE_FORBIDDEN'));
      const [pauseText, pauseParams] = defaults(other, { kind: 'pause' });
      if (state === 'needs_attention') {
        await inContext(other.org, 'owner', async (c) => expect((await c.query(pauseText, pauseParams)).rowCount).toBe(1));
      } else {
        await inContext(other.org, 'owner', (c) => refused(c, pauseText, pauseParams, 'ADS_MANAGE_FORBIDDEN'));
      }
    }
    // An account that is not the launch's.
    const elsewhere = randomUUID();
    const connection = randomUUID();
    await owner(`INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, scopes, connected_by) VALUES ($1, $2, 'sandbox_ads', $3, 'Khác', '{}', $4)`, [r.org.orgId, connection, `acct-${connection.slice(0, 8)}`, r.org.owner]);
    await owner(`INSERT INTO crove_ads.ad_account (org_id, id, channel_connection_id, provider, external_account_id, name, backfill_from, currency, time_zone) VALUES ($1, $2, $3, 'sandbox_ads', $4, 'Khác', '2025-10-01', 'VND', $5)`, [r.org.orgId, elsewhere, connection, `acct-${connection.slice(0, 8)}`, ZONE]);
    const [text, params] = defaults(r, { kind: 'pause' });
    await inContext(r.org, 'owner', (c) => refused(c, text, [r.org.orgId, elsewhere, ...params.slice(2)], 'ADS_MANAGE_FORBIDDEN'));
  });

  it('holds the shape of each kind whoever writes: a "lower" cannot raise, a "raise" cannot lower, a longer schedule is no shortening, a status change carries no value, and the approved kinds carry a proposal', async () => {
    const r = await rig();
    // The table's owner outside any context passes the guard (a definer's statement), so what refuses these is the table's own CHECK, for every writer.
    const shape = (change: Change, constraint: string) => {
      const [text, params] = defaults(r, change);
      return expect(owner(text, params), JSON.stringify(change)).rejects.toMatchObject({ code: '23514', constraint });
    };
    const proposal = randomUUID();
    await shape({ kind: 'budget_lower', fromBudget: '100000', toBudget: '150000' }, 'ad_manage_change_shape_ck');
    await shape({ kind: 'budget_lower', fromBudget: '100000', toBudget: '100000' }, 'ad_manage_change_shape_ck');
    await shape({ kind: 'budget_raise', fromBudget: '100000', toBudget: '60000', proposalId: proposal }, 'ad_manage_change_shape_ck');
    await shape({ kind: 'schedule_shorten', fromEndOn: r.end, toEndOn: D(20) }, 'ad_manage_change_shape_ck');
    await shape({ kind: 'schedule_extend', fromEndOn: r.end, toEndOn: D(5), proposalId: proposal }, 'ad_manage_change_shape_ck');
    await shape({ kind: 'budget_lower', slot: 'campaign', level: 'campaign', fromBudget: '100000', toBudget: '60000' }, 'ad_manage_change_shape_ck');
    await shape({ kind: 'pause', toBudget: '1' }, 'ad_manage_change_shape_ck');
    await shape({ kind: 'archive', toEndOn: D(5) }, 'ad_manage_change_shape_ck');
    await shape({ kind: 'budget_lower', fromBudget: '100000', toBudget: '0' }, 'ad_manage_change_to_budget_check');
    // What can raise spend carries a proposal; what cannot, none.
    await shape({ kind: 'resume', slot: 'ad_1' }, 'ad_manage_change_proposal_ck');
    await shape({ kind: 'budget_raise', fromBudget: '100000', toBudget: '150000' }, 'ad_manage_change_proposal_ck');
    await shape({ kind: 'schedule_extend', fromEndOn: r.end, toEndOn: D(20) }, 'ad_manage_change_proposal_ck');
    await shape({ kind: 'pause', proposalId: proposal }, 'ad_manage_change_proposal_ck');
    // A slot and a level agree; an object has an id of at most 64 characters; a kind is one of seven.
    await shape({ kind: 'pause', slot: 'ad_set', level: 'campaign' }, 'ad_manage_change_level_ck');
    await expect(owner(...defaults(r, { kind: 'pause', objectId: 'x'.repeat(65) }))).rejects.toMatchObject({ code: '23514' });
    await expect(owner(...defaults(r, { kind: 'delete' }))).rejects.toMatchObject({ code: '23514' });
    await expect(owner(...defaults(r, { kind: 'pause', slot: 'ad_4', level: 'ad' }))).rejects.toMatchObject({ code: '23514' });
    expect((await rows<{ n: string }>(`SELECT count(*)::text AS n FROM crove_ads.ad_manage_change WHERE org_id = $1`, [r.org.orgId]))[0]?.n).toBe('0');
  });

  it('judges the values a change moves from against what the launch holds now (ADS_MANAGE_STALE), the direction and the limits of a schedule, and what writing off and blocked launches stop', async () => {
    const r = await rig();
    const attempt = (change: Change, message: string, who: 'owner' | 'admin' = 'owner') => {
      const [text, params] = defaults(r, change);
      return inContext(r.org, who, (c) => refused(c, text, params, message));
    };
    // The values a change moves from are what the launch holds.
    await attempt({ kind: 'budget_lower', fromBudget: '90000', toBudget: '60000' }, 'ADS_MANAGE_STALE');
    await attempt({ kind: 'schedule_shorten', fromEndOn: D(9), toEndOn: D(5) }, 'ADS_MANAGE_STALE');
    // A shorter schedule ends no earlier than today (what ran counts) and no earlier than the first day.
    await attempt({ kind: 'schedule_shorten', fromEndOn: r.end, toEndOn: D(-1) }, 'ADS_MANAGE_FORBIDDEN');
    await attempt({ kind: 'schedule_shorten', fromEndOn: r.end, toEndOn: D(-5) }, 'ADS_MANAGE_FORBIDDEN');
    await request(r, { kind: 'schedule_shorten', fromEndOn: r.end, toEndOn: D(0) }); // today is the earliest end
    // A pause needs neither switch; every other change needs running ads on for the org and for the account.
    await switches(r.org, r.account, { write: false });
    await attempt(LOWER, 'ADS_MANAGE_FORBIDDEN');
    await attempt({ kind: 'archive', slot: 'ad_1' }, 'ADS_MANAGE_FORBIDDEN', 'admin');
    expect(await request(r, { kind: 'pause', slot: 'ad_1' })).toBeTruthy();
    await switches(r.org, r.account, { write: true });
    await switches(r.org, r.account, { accountOn: false });
    await attempt({ kind: 'archive', slot: 'ad_1' }, 'ADS_MANAGE_FORBIDDEN');
    expect(await request(r, { kind: 'pause', slot: 'campaign' })).toBeTruthy();
    await switches(r.org, r.account, { accountOn: true });
    // Blocked launches stop what can start or raise spend (the next test does it for the approved ones) and nothing that only reduces it.
    await switches(r.org, r.account, { blocked: true });
    expect(await request(r, { kind: 'archive', slot: 'ad_set' })).toBeTruthy();
    await switches(r.org, r.account, { blocked: false });
  });

  it('inserts a resume, a raise and an extension only inside the execution of the approved proposal of its own command, with its own launch, object, values and largest amount, and stamps the proposal', async () => {
    const r = await rig();
    // The right proposal, decided by the person in context in this very transaction: the change is made, the proposal is stamped, who asked is the approver.
    for (const [change, command] of [[RAISE, 'ads.budget.raise'], [EXTEND(r), 'ads.schedule.extend'], [RESUME, 'ads.object.resume']] as const) {
      const made = await approved<{ id: string }>(r, change, { commit: false });
      expect(made.id, change.kind).toBeTruthy();
      const stamped = await admin(async (c) => {
        await c.query('BEGIN');
        try {
          await enterUser(c, r.org.owner, r.org.orgId);
          const p = await c.query<{ id: string }>(
            `INSERT INTO crove_kernel.proposal (org_id, kind, command, status, title, payload, decided_by, decided_at, executed_command_id) VALUES ($1, 'ads.manage', $2, 'approved', 'Thử', $3::jsonb, $4, now(), gen_random_uuid()) RETURNING id`,
            [r.org.orgId, command, JSON.stringify({ launchId: r.launch, adAccountId: r.account, slot: change.slot ?? 'ad_set', amount: change.kind === 'budget_raise' ? '2100000' : change.kind === 'schedule_extend' ? '2400000' : '1400000', ...(change.toBudget ? { toBudget: change.toBudget } : {}), ...(change.toEndOn ? { toEndOn: change.toEndOn } : {}) }), r.org.owner],
          );
          const [text, params] = defaults(r, { ...change, proposalId: randomUUID() });
          const row = (await c.query<{ id: string }>(text, params)).rows[0] as { id: string };
          const out = await c.query<{ proposal_id: string; requested_by: string }>(`SELECT proposal_id, requested_by FROM crove_ads.ad_manage_change WHERE org_id = $1 AND id = $2`, [r.org.orgId, row.id]);
          return { proposal: p.rows[0]?.id, ...out.rows[0] };
        } finally {
          await c.query('ROLLBACK').catch(() => undefined);
        }
      });
      // The guard replaces whatever proposal id the statement named with the approved proposal's own, and records the approver as the one who asked.
      expect(stamped.proposal_id, change.kind).toBe(stamped.proposal);
      expect(stamped.requested_by, change.kind).toBe(r.org.owner);
    }
    const refuse = (change: Change, over: Parameters<typeof approved>[2], message = 'ADS_MANAGE_FORBIDDEN') => expect(approved(r, change, over), `${change.kind} ${JSON.stringify(over)}`).rejects.toMatchObject({ code: '42501', message: expect.stringContaining(message) });
    // No approved proposal at all: an owner's own statement, an admin's, and the table's owner in an owner's context.
    for (const change of [RAISE, EXTEND(r), RESUME]) {
      const [text, params] = defaults(r, { ...change, proposalId: randomUUID() });
      for (const who of ['owner', 'admin'] as const) await inContext(r.org, who, (c) => refused(c, text, params, 'ADS_MANAGE_FORBIDDEN'));
      await inContext(r.org, 'system', (c) => refused(c, text, params, 'ADS_MANAGE_FORBIDDEN'));
    }
    // A proposal of another command, one that is only pending, one a member decided or another person decided, one for another launch, another object, another amount, other values.
    await refuse(RAISE, { command: 'ads.schedule.extend' });
    await refuse(EXTEND(r), { command: 'ads.budget.raise' });
    await refuse(RESUME, { command: 'ads.campaign.launch' });
    await refuse(RAISE, { status: 'pending' });
    await refuse(RAISE, { status: 'rejected' });
    await refuse(RAISE, { decidedBy: r.org.admin });
    await refuse(RAISE, { payload: { launchId: randomUUID() } });
    await refuse(RAISE, { payload: { adAccountId: randomUUID() } });
    await refuse(RESUME, { payload: { slot: 'campaign' } });
    await refuse(RAISE, { amount: '2100001' });
    await refuse(RAISE, { amount: '1400000' });
    await refuse(RAISE, { payload: { toBudget: '149999' } });
    await refuse(EXTEND(r), { payload: { toEndOn: D(19) } });
    await refuse(EXTEND(r), { amount: '2100000' });
    await refuse(RESUME, { amount: '1400001' });
    // The proposal of an earlier transaction is no licence (it was decided before this statement): committed first, then used from another.
    const earlier = await approved<{ id: string }>(r, RAISE, { commit: true });
    expect(earlier.id).toBeTruthy();
    await rows(`DELETE FROM crove_ads.ad_manage_change WHERE org_id = $1`, [r.org.orgId]);
    const [text, params] = defaults(r, { ...RAISE, proposalId: randomUUID() });
    await inContext(r.org, 'owner', (c) => refused(c, text, params, 'ADS_MANAGE_FORBIDDEN'));
    // The 90 days of a flight are the database's too: an extension past the ninetieth day is refused even with the right amount.
    await refuse({ kind: 'schedule_extend', fromEndOn: r.end, toEndOn: D(87) }, { amount: String(100000 * 91) });
    // The stale values of an approved raise are refused as any other (ADS_MANAGE_STALE).
    await refuse({ ...RAISE, fromBudget: '80000' }, {}, 'ADS_MANAGE_STALE');
    // Running ads off and blocked launches stop all three, whatever was approved.
    await switches(r.org, r.account, { write: false });
    await refuse(RAISE, {});
    await refuse(RESUME, {});
    await switches(r.org, r.account, { write: true, blocked: true });
    await refuse(RAISE, {});
    await refuse(EXTEND(r), {});
    await refuse(RESUME, {});
    await switches(r.org, r.account, { blocked: false });
    expect((await rows<{ n: string }>(`SELECT count(*)::text AS n FROM crove_ads.ad_manage_change WHERE org_id = $1`, [r.org.orgId]))[0]?.n).toBe('0');
  });

  it('lets the system settle a queued change and an owner, an admin or the system cancel one the job never begun, and no one else; a settled change never changes; the stamps are the database’s', async () => {
    const r = await rig();
    const settleBy = (who: Who, id: string, set: string) => inContext(r.org, who, (c) => c.query(`UPDATE crove_ads.ad_manage_change SET ${set} WHERE org_id = $1 AND id = $2`, [r.org.orgId, id]));
    const first = await request(r, LOWER);
    // A person does not settle a change: applied, failed and unclear are the job's record.
    for (const who of ['owner', 'admin', 'member', 'viewer'] as const) {
      for (const state of ['applied', 'failed', 'unclear']) {
        await inContext(r.org, who, (c) => refused(c, `UPDATE crove_ads.ad_manage_change SET state = '${state}' WHERE org_id = $1 AND id = $2`, [r.org.orgId, first], 'ADS_MANAGE_FORBIDDEN'));
      }
    }
    // A member and a viewer do not cancel one either; an unknown state and a return to queued are no move.
    for (const who of ['member', 'viewer'] as const) await inContext(r.org, who, (c) => refused(c, `UPDATE crove_ads.ad_manage_change SET state = 'cancelled' WHERE org_id = $1 AND id = $2`, [r.org.orgId, first], 'ADS_MANAGE_FORBIDDEN'));
    await expect(settleBy('system', first, `state = 'bogus'`)).rejects.toMatchObject({ code: '42501' });
    // Nothing that identifies a change ever changes: no column grant for a login, the guard for the table's owner.
    for (const [column, value] of [['kind', "'pause'"], ['to_budget', '1'], ['from_budget', '200000'], ['proposal_id', 'gen_random_uuid()'], ['requested_by', 'gen_random_uuid()'], ['launch_id', 'gen_random_uuid()'], ['object_id', "'x'"], ['slot', "'ad_1'"], ['created_at', 'now()']] as const) {
      await expect(settleBy('system', first, `${column} = ${value}`), column).rejects.toMatchObject({ code: '42501' });
      await expect(owner(`UPDATE crove_ads.ad_manage_change SET ${column} = ${value} WHERE org_id = $1 AND id = $2`, [r.org.orgId, first]), `${column} (table's owner)`).rejects.toMatchObject({ code: expect.stringMatching(/^(42501|23514|23503)$/) });
    }
    // The system settles it: the day it was applied and the time are the database's, whatever the statement said.
    await inContext(r.org, 'system', (c) => c.query(`UPDATE crove_ads.ad_manage_change SET state = 'applied', settled_on = '2001-01-01', settled_at = '2001-01-01T00:00:00Z' WHERE org_id = $1 AND id = $2`, [r.org.orgId, first]), true);
    const done = await get(r, first);
    expect(done).toMatchObject({ state: 'applied', code: null, settled_on: today });
    expect(done?.settled_at).toBeInstanceOf(Date);
    expect(((done as NonNullable<typeof done>).settled_at as Date).getUTCFullYear()).toBeGreaterThan(2020);
    // A settled change never changes, whoever writes (an owner, the system, the table's owner too).
    for (const who of ['owner', 'admin', 'system'] as const) {
      for (const state of ['cancelled', 'failed', 'applied']) {
        await inContext(r.org, who, (c) => refused(c, `UPDATE crove_ads.ad_manage_change SET state = '${state}', code = 'AGAIN' WHERE org_id = $1 AND id = $2`, [r.org.orgId, first], 'ADS_MANAGE_FROZEN'));
      }
    }
    await expect(owner(`UPDATE crove_ads.ad_manage_change SET state = 'failed' WHERE org_id = $1 AND id = $2`, [r.org.orgId, first])).rejects.toMatchObject({ code: '42501' });
    expect((await get(r, first))?.state).toBe('applied');
    // Cancelled by an owner, by an admin, by the system (a stop found it queued): the day applied is for what was applied, never for a cancel.
    for (const who of ['owner', 'admin', 'system'] as const) {
      const id = await request(r, { kind: 'pause', slot: 'ad_1' });
      await inContext(r.org, who, (c) => c.query(`UPDATE crove_ads.ad_manage_change SET state = 'cancelled', code = 'cancelled', settled_on = '2001-01-01' WHERE org_id = $1 AND id = $2`, [r.org.orgId, id]), true);
      expect(await get(r, id), who).toMatchObject({ state: 'cancelled', code: 'cancelled', settled_on: null });
      // The stamp of a refused or failed one is the same: no day.
      await owner(`DELETE FROM crove_ads.ad_manage_change WHERE org_id = $1 AND id = $2`, [r.org.orgId, id]);
    }
    for (const state of ['failed', 'unclear'] as const) {
      const id = await request(r, { kind: 'pause', slot: 'ad_1' });
      await inContext(r.org, 'system', (c) => c.query(`UPDATE crove_ads.ad_manage_change SET state = '${state}', code = 'X', settled_on = '2001-01-01' WHERE org_id = $1 AND id = $2`, [r.org.orgId, id]), true);
      expect(await get(r, id), state).toMatchObject({ state, code: 'X', settled_on: null });
    }
  });

  it('lets the system settle an unclear change as applied or failed and nothing else; no person does, and a change a newer one overtook stays as it is (#3898)', async () => {
    const r = await rig();
    const unclear = await request(r, LOWER);
    await settle(r, unclear, 'unclear', 'reconcile_unclear');
    // A person never settles it, and nothing but applied or failed is a move out of unclear: cancelled, queued, and a new unclear are frozen or no move.
    for (const who of ['owner', 'admin', 'member', 'viewer'] as const) {
      for (const state of ['applied', 'failed', 'cancelled']) {
        await inContext(r.org, who, (c) => refused(c, `UPDATE crove_ads.ad_manage_change SET state = '${state}', code = 'X' WHERE org_id = $1 AND id = $2`, [r.org.orgId, unclear], 'ADS_MANAGE_FROZEN'));
      }
    }
    await inContext(r.org, 'system', (c) => refused(c, `UPDATE crove_ads.ad_manage_change SET state = 'cancelled', code = 'X' WHERE org_id = $1 AND id = $2`, [r.org.orgId, unclear], 'ADS_MANAGE_FROZEN'));
    await inContext(r.org, 'system', (c) => refused(c, `UPDATE crove_ads.ad_manage_change SET state = 'queued', code = NULL WHERE org_id = $1 AND id = $2`, [r.org.orgId, unclear], 'ADS_MANAGE_FROZEN'));
    // Nothing that identifies the change moves, whoever writes it, from unclear as from queued.
    for (const [column, value] of [['to_budget', '1'], ['kind', "'pause'"], ['launch_id', 'gen_random_uuid()']] as const) {
      await expect(inContext(r.org, 'system', (c) => c.query(`UPDATE crove_ads.ad_manage_change SET ${column} = ${value}, state = 'applied' WHERE org_id = $1 AND id = $2`, [r.org.orgId, unclear])), column).rejects.toMatchObject({ code: '42501' });
    }
    expect((await get(r, unclear))?.state).toBe('unclear');
    // A newer change of the family that is queued, applied or unclear is what the platform shows: the older unclear one is not settled by a read of it. A raise approved behind it
    // (a raise is not held back by an unclear change) is such a change.
    const raise = await approved<{ id: string }>(r, RAISE, { commit: true });
    await inContext(r.org, 'system', (c) => refused(c, `UPDATE crove_ads.ad_manage_change SET state = 'applied' WHERE org_id = $1 AND id = $2`, [r.org.orgId, unclear], 'ADS_MANAGE_FROZEN'));
    await settle(r, raise.id, 'applied');
    await inContext(r.org, 'system', (c) => refused(c, `UPDATE crove_ads.ad_manage_change SET state = 'failed' WHERE org_id = $1 AND id = $2`, [r.org.orgId, unclear], 'ADS_MANAGE_FROZEN'));
    expect((await get(r, unclear))?.state).toBe('unclear');
    // Another family does not overtake it: a pause is not a change of the budget.
    const other = await rig();
    const lower = await request(other, LOWER);
    await settle(other, lower, 'unclear', 'reconcile_unclear');
    await request(other, { kind: 'pause', slot: 'campaign' });
    // Applied by the system: the day is the database's, the time too, whatever the statement said; and the held budget is the confirmed one.
    await inContext(other.org, 'system', (c) => c.query(`UPDATE crove_ads.ad_manage_change SET state = 'applied', code = NULL, settled_on = '2001-01-01' WHERE org_id = $1 AND id = $2`, [other.org.orgId, lower]), true);
    expect(await get(other, lower)).toMatchObject({ state: 'applied', code: null, settled_on: today });
    expect(await hold(other)).toEqual({ daily_budget: '60000', end_on: other.end });
    // And it is settled for good: a settled change never changes.
    for (const state of ['failed', 'applied', 'unclear']) {
      await inContext(other.org, 'system', (c) => refused(c, `UPDATE crove_ads.ad_manage_change SET state = '${state}', code = 'AGAIN' WHERE org_id = $1 AND id = $2`, [other.org.orgId, lower], 'ADS_MANAGE_FROZEN'));
    }
    // Failed by the system (the object was as it was): nothing was released and nothing is held, and the lower budget the person wanted can be asked for again.
    const third = await rig();
    const missed = await request(third, LOWER);
    await settle(third, missed, 'unclear', 'reconcile_unclear');
    await settle(third, missed, 'failed', 'unclear_not_applied');
    expect(await get(third, missed)).toMatchObject({ state: 'failed', code: 'unclear_not_applied', settled_on: null });
    expect(await hold(third)).toEqual({ daily_budget: '100000', end_on: third.end });
    expect(await request(third, LOWER)).toBeTruthy();
  });

  it('picks the unclear changes a worker may read, and only the worker: old enough, nothing newer of the family, an active write connection of a provider it has a manager for (#3898)', async () => {
    const r = await rig();
    const connection = randomUUID();
    await owner(`INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, scopes, connected_by) VALUES ($1, $2, 'sandboxwrite_ads', $3, 'Thử ghi', '{}', $4)`, [r.org.orgId, connection, `write-${connection.slice(0, 8)}`, r.org.owner]);
    // The account's write connection (its own guard is not what this test is about, so the table's owner sets it with that guard aside for the one statement, as a backfill would).
    await admin(async (c) => {
      await c.query('BEGIN');
      try {
        await c.query('ALTER TABLE crove_ads.ad_account DISABLE TRIGGER write_connection_guard');
        await c.query(`UPDATE crove_ads.ad_account SET write_connection_id = $3 WHERE org_id = $1 AND id = $2`, [r.org.orgId, r.account, connection]);
        await c.query('ALTER TABLE crove_ads.ad_account ENABLE ALWAYS TRIGGER write_connection_guard');
        await c.query('COMMIT');
      } catch (e) {
        await c.query('ROLLBACK');
        throw e;
      }
    });
    const pick = (providers: string[] = ['sandboxwrite_ads']) => withClient(workerUrl, async (c) => (await c.query<{ org_id: string; change_id: string }>(`SELECT org_id, change_id FROM crove_ads.manage_unclear_pick($1::text[], 100)`, [providers])).rows.filter((x) => x.org_id === r.org.orgId));
    const unclear = await request(r, LOWER);
    await settle(r, unclear, 'unclear', 'reconcile_unclear');
    // Without the ledger row of its call (begun and committed before the platform is called) there is nothing to read for.
    expect(await pick()).toEqual([]);
    const key = `ads.manage:${unclear}:apply`;
    await owner(`INSERT INTO crove_kernel.external_call (org_id, key, module, target, step, retry_safety, started_at) VALUES ($1, $2, 'ads', 'launch', 'manage_budget_lower', 'idempotent', now())`, [r.org.orgId, key]);
    await owner(`UPDATE crove_kernel.external_call SET state = 'ambiguous', error_kind = 'unknown', error_code = 'NETWORK' WHERE org_id = $1 AND key = $2`, [r.org.orgId, key]);
    // Too soon: a call whose answer was lost may still be landing.
    expect(await pick()).toEqual([]);
    await owner(`UPDATE crove_kernel.external_call SET updated_at = now() - interval '11 minutes' WHERE org_id = $1 AND key = $2`, [r.org.orgId, key]);
    expect(await pick()).toEqual([{ org_id: r.org.orgId, change_id: unclear }]);
    // A provider the worker has no manager for, and a closed connection, are not picked.
    expect(await pick(['other_ads'])).toEqual([]);
    await owner(`UPDATE crove_kernel.channel_connection SET status = 'revoked' WHERE org_id = $1 AND id = $2`, [r.org.orgId, connection]);
    expect(await pick()).toEqual([]);
    await owner(`UPDATE crove_kernel.channel_connection SET status = 'active' WHERE org_id = $1 AND id = $2`, [r.org.orgId, connection]);
    expect(await pick()).toEqual([{ org_id: r.org.orgId, change_id: unclear }]);
    // A newer change of its family (queued here) is what the platform shows: the read would say nothing of the older one.
    const raise = await approved<{ id: string }>(r, RAISE, { commit: true });
    expect(await pick()).toEqual([]);
    await settle(r, raise.id, 'failed', 'REFUSED');
    expect(await pick()).toEqual([{ org_id: r.org.orgId, change_id: unclear }]);
    // What begin could only answer "not now" for is not picked, so it cannot crowd out the rest: a schedule change of an account whose zone is not read yet.
    const shorten = await request(r, SHORTEN(r));
    await settle(r, shorten, 'unclear', 'reconcile_unclear');
    await owner(`INSERT INTO crove_kernel.external_call (org_id, key, module, target, step, retry_safety, started_at) VALUES ($1, $2, 'ads', 'launch', 'manage_schedule_shorten', 'idempotent', now())`, [r.org.orgId, `ads.manage:${shorten}:apply`]);
    await owner(`UPDATE crove_kernel.external_call SET state = 'ambiguous', error_kind = 'unknown', error_code = 'NETWORK', updated_at = now() - interval '11 minutes' WHERE org_id = $1 AND key = $2`, [r.org.orgId, `ads.manage:${shorten}:apply`]);
    expect((await pick()).map((x) => x.change_id).sort()).toEqual([shorten, unclear].sort());
    await owner(`UPDATE crove_ads.ad_account SET time_zone = NULL WHERE org_id = $1 AND id = $2`, [r.org.orgId, r.account]);
    expect(await pick()).toEqual([{ org_id: r.org.orgId, change_id: unclear }]);
    await owner(`UPDATE crove_ads.ad_account SET time_zone = $3 WHERE org_id = $1 AND id = $2`, [r.org.orgId, r.account, ZONE]);
    // Only the worker's login picks, and it settles nothing: a login of the API refuses.
    await withClient(appUrl, async (c) => {
      await expect(c.query(`SELECT * FROM crove_ads.manage_unclear_pick(ARRAY['sandboxwrite_ads'], 10)`)).rejects.toMatchObject({ code: '42501' });
    });
    const fn = (await rows<{ definer: boolean; config: string[] | null; app: boolean; worker: boolean; tenant: boolean; pub: boolean }>(
      `SELECT p.prosecdef AS definer, p.proconfig AS config, has_function_privilege('crove_app', p.oid, 'EXECUTE') AS app, has_function_privilege('crove_worker', p.oid, 'EXECUTE') AS worker, has_function_privilege('crove_tenant', p.oid, 'EXECUTE') AS tenant,
              EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x WHERE x.grantee = 0) AS pub
       FROM pg_proc p WHERE p.oid = to_regprocedure('crove_ads.manage_unclear_pick(text[], integer)')`,
    ))[0];
    expect(fn).toMatchObject({ definer: true, config: ['search_path=pg_catalog, pg_temp'], app: false, worker: true, tenant: false, pub: false });
  });

  it('refuses the cancel of a change the job has begun (it may have landed), whoever asks, and never deletes: no login can delete a row, and a purge goes with the account', async () => {
    const r = await rig();
    const id = await request(r, LOWER);
    // The job's begin commits the ledger row of the call under this key before the platform is called.
    await owner(`INSERT INTO crove_kernel.external_call (org_id, key, module, target, step, retry_safety, started_at) VALUES ($1, $2, 'ads', 'launch', 'manage_budget_lower', 'idempotent', now())`, [r.org.orgId, `ads.manage:${id}:apply`]);
    for (const who of ['owner', 'admin', 'system'] as const) {
      await inContext(r.org, who, (c) => refused(c, `UPDATE crove_ads.ad_manage_change SET state = 'cancelled' WHERE org_id = $1 AND id = $2`, [r.org.orgId, id], 'ADS_MANAGE_FORBIDDEN'));
    }
    // The job still settles it.
    await settle(r, id, 'applied');
    expect((await get(r, id))?.state).toBe('applied');
    for (const who of ['owner', 'admin', 'system'] as const) {
      await inContext(r.org, who, (c) => expect(c.query(`DELETE FROM crove_ads.ad_manage_change WHERE org_id = $1`, [r.org.orgId])).rejects.toMatchObject({ code: '42501' }));
      await inContext(r.org, who, (c) => expect(c.query(`TRUNCATE crove_ads.ad_manage_change`)).rejects.toMatchObject({ code: '42501' }));
    }
    // The account's own deletion removes its changes with it (the purge's way).
    await owner(`DELETE FROM crove_ads.ad_account WHERE org_id = $1 AND id = $2`, [r.org.orgId, r.account]);
    expect((await rows<{ n: string }>(`SELECT count(*)::text AS n FROM crove_ads.ad_manage_change WHERE org_id = $1`, [r.org.orgId]))[0]?.n).toBe('0');
  });

  it('allows one change of a family at a time while it waits for the platform: the budget, the schedule and each object’s status are three families, and a settled change frees its family', async () => {
    const r = await rig();
    const a = await request(r, LOWER);
    const second = defaults(r, { kind: 'budget_lower', fromBudget: '100000', toBudget: '50000' });
    await expect(inContext(r.org, 'owner', (c) => c.query(...second))).rejects.toMatchObject({ code: '23505', constraint: 'ad_manage_change_open_uq' });
    // The family of a change is the database's: budget, schedule, or the status of one slot.
    const b = await request(r, SHORTEN(r));
    const c1 = await request(r, { kind: 'pause', slot: 'campaign' });
    const c2 = await request(r, { kind: 'pause', slot: 'ad_set' });
    expect([a, b, c1, c2].map((id) => id)).toHaveLength(4);
    expect((await rows<{ family: string }>(`SELECT family FROM crove_ads.ad_manage_change WHERE org_id = $1 ORDER BY seq`, [r.org.orgId])).map((f) => f.family)).toEqual(['budget', 'schedule', 'status:campaign', 'status:ad_set']);
    await expect(request(r, { kind: 'archive', slot: 'campaign' })).rejects.toMatchObject({ code: '23505' });
    // Settled, the family is free again (the new change goes from what the launch now holds).
    await settle(r, a, 'applied');
    expect(await request(r, { kind: 'budget_lower', fromBudget: '60000', toBudget: '50000' })).toBeTruthy();
  });

  it('never releases a commitment before the platform confirms it: a lower budget and a shorter schedule hold what they were until applied, a failed or cancelled one changes nothing', async () => {
    const r = await rig();
    expect(await hold(r)).toEqual({ daily_budget: '100000', end_on: r.end });
    expect(await committed(r)).toEqual({ daily_budget: '100000', commit_until: r.end });
    const lower = await request(r, LOWER);
    const shorten = await request(r, SHORTEN(r));
    // Queued: nothing is released.
    expect(await hold(r)).toEqual({ daily_budget: '100000', end_on: r.end });
    expect(await committed(r)).toEqual({ daily_budget: '100000', commit_until: r.end });
    // The platform refused the lower budget: nothing was released; the shorter schedule was cancelled before it began: nothing either.
    await settle(r, lower, 'failed', 'REFUSED');
    await inContext(r.org, 'owner', (c) => c.query(`UPDATE crove_ads.ad_manage_change SET state = 'cancelled', code = 'cancelled' WHERE org_id = $1 AND id = $2`, [r.org.orgId, shorten]), true);
    expect(await committed(r)).toEqual({ daily_budget: '100000', commit_until: r.end });
    // Unclear (the answer could not be told) releases nothing either: it may not have applied.
    const unclearLower = await request(r, LOWER);
    await settle(r, unclearLower, 'unclear', 'reconcile_unclear');
    expect(await hold(r)).toEqual({ daily_budget: '100000', end_on: r.end });
    // Applied: the commitment is the confirmed one, and the next change moves from it.
    const next = await requestBehindUnclear(r, { kind: 'budget_lower', fromBudget: '100000', toBudget: '70000' });
    await settle(r, next, 'applied');
    expect(await hold(r)).toEqual({ daily_budget: '70000', end_on: r.end });
    expect(await committed(r)).toEqual({ daily_budget: '70000', commit_until: r.end });
    const shorter = await request(r, { kind: 'schedule_shorten', fromEndOn: r.end, toEndOn: D(4) });
    expect(await committed(r)).toEqual({ daily_budget: '70000', commit_until: r.end });
    await settle(r, shorter, 'applied');
    expect(await hold(r)).toEqual({ daily_budget: '70000', end_on: D(4) });
    expect(await committed(r)).toEqual({ daily_budget: '70000', commit_until: D(4) });
    // The same stale value is refused afterwards: the launch holds 70 000 now.
    const [text, params] = defaults(r, { kind: 'budget_lower', fromBudget: '100000', toBudget: '50000' });
    await inContext(r.org, 'owner', (c) => refused(c, text, params, 'ADS_MANAGE_STALE'));
  });

  it('holds a raise or an extension that is queued or unclear as an upper bound and releases a failed or cancelled one; a newer confirmed change ends the hold of an older raise', async () => {
    const r = await rig();
    const raise = await approved<{ id: string }>(r, RAISE, { commit: true });
    // Queued: held at the higher figure BEFORE any platform call; the amount a plan is judged against includes it.
    expect(await hold(r)).toEqual({ daily_budget: '150000', end_on: r.end });
    expect(await committed(r)).toEqual({ daily_budget: '150000', commit_until: r.end });
    // The extension is judged at the budget the launch holds now (the queued raise's 150 000 over the 24 days of the longer flight).
    const extend = await approved<{ id: string }>(r, EXTEND(r), { commit: true, amount: String(150000 * 24) });
    expect(await hold(r)).toEqual({ daily_budget: '150000', end_on: D(20) });
    expect(await committed(r)).toEqual({ daily_budget: '150000', commit_until: D(20) });
    // A failed or cancelled raise is released; an unclear one stays held.
    await settle(r, extend.id, 'failed', 'REFUSED');
    expect(await hold(r)).toEqual({ daily_budget: '150000', end_on: r.end });
    await settle(r, raise.id, 'unclear', 'reconcile_unclear');
    expect(await hold(r)).toEqual({ daily_budget: '150000', end_on: r.end });
    // A lower budget asked while the raise is unclear goes from what is held (150 000), releases nothing until applied, and once applied it ends the hold of the older raise.
    const lower = await requestBehindUnclear(r, { kind: 'budget_lower', fromBudget: '150000', toBudget: '120000' });
    expect(await hold(r)).toEqual({ daily_budget: '150000', end_on: r.end });
    await settle(r, lower, 'applied');
    expect(await hold(r)).toEqual({ daily_budget: '120000', end_on: r.end });
    // A raise that applied is the confirmed budget; a cancelled one never was held.
    const again = await approved<{ id: string }>(r, { kind: 'budget_raise', fromBudget: '120000', toBudget: '130000' }, { commit: true, amount: String(130000 * 14) });
    await inContext(r.org, 'system', (c) => c.query(`UPDATE crove_ads.ad_manage_change SET state = 'cancelled', code = 'cap_lowered' WHERE org_id = $1 AND id = $2`, [r.org.orgId, again.id]), true);
    expect(await hold(r)).toEqual({ daily_budget: '120000', end_on: r.end });
    const third = await approved<{ id: string }>(r, { kind: 'budget_raise', fromBudget: '120000', toBudget: '140000' }, { commit: true, amount: String(140000 * 14) });
    await settle(r, third.id, 'applied');
    expect(await hold(r)).toEqual({ daily_budget: '140000', end_on: r.end });
    expect(await committed(r)).toEqual({ daily_budget: '140000', commit_until: r.end });
  });

  it('ends the commitment of an ad set or a campaign archived at the platform at the day it was applied, and of nothing else: an ad, a pause and a queued archive keep it', async () => {
    const r = await rig();
    // An ad archived, a campaign paused and an ad set archive that is still queued: the commitment to the last day.
    await settle(r, await request(r, { kind: 'archive', slot: 'ad_1' }), 'applied');
    await settle(r, await request(r, { kind: 'pause', slot: 'campaign' }), 'applied');
    const adSet = await request(r, { kind: 'archive', slot: 'ad_set' });
    expect(await committed(r)).toEqual({ daily_budget: '100000', commit_until: r.end });
    await settle(r, adSet, 'failed', 'REFUSED');
    expect(await committed(r)).toEqual({ daily_budget: '100000', commit_until: r.end });
    // Applied: what ran counts, the days after the day it was applied are released.
    const again = await request(r, { kind: 'archive', slot: 'ad_set' });
    await settle(r, again, 'applied');
    expect((await get(r, again))?.settled_on).toBe(today);
    expect(await committed(r)).toEqual({ daily_budget: '100000', commit_until: today });
    // A campaign archive ends it the same way, for a launch of its own.
    const other = await rig();
    await settle(other, await request(other, { kind: 'archive', slot: 'campaign' }), 'applied');
    expect(await committed(other)).toEqual({ daily_budget: '100000', commit_until: today });
  });

  it('commits each day at the highest budget that may have been running on it: a lower budget releases only the days after it was confirmed, a raise counts from the day before it was asked for, an unclear raise keeps counting for the days it may have run', async () => {
    // The launch's commitment day by day (a launch with a change of the budget answers one row a day).
    const perDay = async (rg: Rig) => {
      const out = await inContext(rg.org, 'owner', async (c) => (await c.query<{ daily_budget: string; start_on: string; commit_until: string }>(`SELECT daily_budget, start_on::text, commit_until::text FROM crove_ads.launch_commitments('VND', $1::date, $2::date) WHERE ad_account_id = $3`, [D(-30), D(300), rg.account])).rows);
      const days = new Map<string, number>();
      for (const row of out) for (let d = row.start_on; d <= row.commit_until; d = addDays(d, 1)) days.set(d, (days.get(d) ?? 0) + Number(row.daily_budget));
      return days;
    };
    const asked = async (rg: Rig, id: string) => (await rows<{ d: string }>(`SELECT ((created_at AT TIME ZONE 'UTC')::date - 1)::text AS d FROM crove_ads.ad_manage_change WHERE org_id = $1 AND id = $2`, [rg.org.orgId, id]))[0]?.d as string;
    const upTo = (days: Map<string, number>, from: string, to: string) => [...days.entries()].filter(([d]) => d >= from && d <= to).map(([, v]) => v);
    const all = (v: number, n: number) => Array.from({ length: n }, () => v);
    const span = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;

    // A lower budget: queued, nothing changes; confirmed, the days up to the day it was applied stay at 100 000 and only the later days are at 60 000.
    const a = await rig();
    expect(upTo(await perDay(a), a.start, a.end)).toEqual(all(100000, span(a.start, a.end)));
    const lower = await request(a, LOWER);
    expect(upTo(await perDay(a), a.start, a.end)).toEqual(all(100000, span(a.start, a.end)));
    await settle(a, lower, 'applied');
    const S = (await get(a, lower))?.settled_on as string;
    const lowered = await perDay(a);
    expect(upTo(lowered, a.start, S)).toEqual(all(100000, span(a.start, S)));
    expect(upTo(lowered, addDays(S, 1), a.end)).toEqual(all(60000, span(addDays(S, 1), a.end)));

    // A raise alone, confirmed: from the day before it was asked for at the higher budget, the days before at the old one.
    const b = await rig();
    const up = await approved<{ id: string }>(b, RAISE, { commit: true });
    const from = await asked(b, up.id);
    // While it waits it counts to the end at the higher figure.
    expect(upTo(await perDay(b), from, b.end)).toEqual(all(150000, span(from, b.end)));
    expect(upTo(await perDay(b), b.start, addDays(from, -1))).toEqual(all(100000, span(b.start, addDays(from, -1))));
    await settle(b, up.id, 'applied');
    expect(upTo(await perDay(b), from, b.end)).toEqual(all(150000, span(from, b.end)));

    // A lower budget confirmed the same day as a raise: the days up to that day are at the higher of the two (100 000), the later days at the raise.
    const c = await rig();
    const lc = await request(c, LOWER);
    await settle(c, lc, 'applied');
    const rc = await approved<{ id: string }>(c, { kind: 'budget_raise', fromBudget: '60000', toBudget: '90000' }, { commit: true, amount: String(90000 * 14) });
    await settle(c, rc.id, 'applied');
    const Sc = (await get(c, lc))?.settled_on as string;
    const same = await perDay(c);
    expect(upTo(same, c.start, Sc).every((v) => v >= 100000)).toBe(true);
    expect(upTo(same, addDays(Sc, 1), c.end)).toEqual(all(90000, span(addDays(Sc, 1), c.end)));

    // An UNCLEAR raise (it may have run), then a lower budget confirmed later: the days between still count at the raise, not at the old budget.
    const d = await rig();
    const unclear = await approved<{ id: string }>(d, RAISE, { commit: true });
    await settle(d, unclear.id, 'unclear', 'reconcile_unclear');
    const fromD = await asked(d, unclear.id);
    const ld = await requestBehindUnclear(d, { kind: 'budget_lower', fromBudget: '150000', toBudget: '120000' });
    await settle(d, ld, 'applied');
    const Sd = (await get(d, ld))?.settled_on as string;
    const out = await perDay(d);
    expect(upTo(out, fromD, Sd)).toEqual(all(150000, span(fromD, Sd)));
    expect(upTo(out, addDays(Sd, 1), d.end)).toEqual(all(120000, span(addDays(Sd, 1), d.end)));
    expect(upTo(out, d.start, addDays(fromD, -1))).toEqual(all(100000, span(d.start, addDays(fromD, -1))));
  });

  it('keeps the days an extended schedule ran when the launch is stopped and wound down: the commitment goes to the day it stopped, not back to the first end', async () => {
    const r = await rig();
    const extend = await approved<{ id: string }>(r, EXTEND(r), { commit: true, amount: String(100000 * 24) });
    await settle(r, extend.id, 'applied');
    // Stopped today (the first end, D(10), is in the future; the extended end is D(20)) and wound down: the pause job's work is done.
    await inContext(r.org, 'system', (c) => c.query(`UPDATE crove_ads.ad_launch SET state = 'stopped', stop_reason = 'stopped', commit_until = $3::date WHERE org_id = $1 AND id = $2`, [r.org.orgId, r.launch, today]), true);
    await admin(async (c) => {
      await c.query('BEGIN');
      try {
        await c.query('ALTER TABLE crove_ads.ad_launch DISABLE TRIGGER launch_guard');
        await c.query(`UPDATE crove_ads.ad_launch SET wound_down_at = now() WHERE org_id = $1 AND id = $2`, [r.org.orgId, r.launch]);
        await c.query('ALTER TABLE crove_ads.ad_launch ENABLE ALWAYS TRIGGER launch_guard');
        await c.query('COMMIT');
      } catch (e) {
        await c.query('ROLLBACK');
        throw e;
      }
    });
    // A schedule extension that is still queued when the launch stops may already have run at the platform: its days count too.
    const last = (await committed(r)) as { daily_budget: string; commit_until: string };
    // At least the day it stopped, and never past the extended end: the extended days that ran are not forgotten.
    expect(last.commit_until >= today).toBe(true);
    expect(last.commit_until <= D(20)).toBe(true);
  });

  it('keeps the days of a schedule extension that was still queued when the launch stopped and was wound down: it may already have run at the platform', async () => {
    const r = await rig();
    await approved<{ id: string }>(r, EXTEND(r), { commit: true, amount: String(100000 * 24) });
    // Stopped today (the first end, D(10), is in the future; the extended end is D(20)) and wound down: the pause job's work is done.
    await inContext(r.org, 'system', (c) => c.query(`UPDATE crove_ads.ad_launch SET state = 'stopped', stop_reason = 'stopped', commit_until = $3::date WHERE org_id = $1 AND id = $2`, [r.org.orgId, r.launch, today]), true);
    await admin(async (c) => {
      await c.query('BEGIN');
      try {
        await c.query('ALTER TABLE crove_ads.ad_launch DISABLE TRIGGER launch_guard');
        await c.query(`UPDATE crove_ads.ad_launch SET wound_down_at = now() WHERE org_id = $1 AND id = $2`, [r.org.orgId, r.launch]);
        await c.query('ALTER TABLE crove_ads.ad_launch ENABLE ALWAYS TRIGGER launch_guard');
        await c.query('COMMIT');
      } catch (e) {
        await c.query('ROLLBACK');
        throw e;
      }
    });
    // A schedule extension that is still queued when the launch stops may already have run at the platform: its days count too.
    const last = (await committed(r)) as { daily_budget: string; commit_until: string };
    // At least the day it stopped, and never past the extended end: the extended days that ran are not forgotten.
    expect(last.commit_until >= today).toBe(true);
    expect(last.commit_until <= D(20)).toBe(true);
  });

  it('refuses, at the database, a resume, a raise and an extension of a launch whose ad set or campaign was archived: it no longer delivers', async () => {
    const r = await rig();
    await settle(r, await request(r, { kind: 'archive', slot: 'ad_set' }), 'applied');
    for (const change of [RAISE, EXTEND(r), RESUME]) {
      await expect(approved(r, change, { commit: true }), change.kind).rejects.toMatchObject({ message: expect.stringContaining('ADS_MANAGE_FORBIDDEN') });
    }
    // A reducing change is still allowed (a pause, a lower budget): stopping spend is never refused.
    await request(r, { kind: 'pause', slot: 'campaign' });
    // The same for a campaign archive.
    const c = await rig();
    await settle(c, await request(c, { kind: 'archive', slot: 'campaign' }), 'applied');
    await expect(approved(c, RAISE, { commit: true })).rejects.toMatchObject({ message: expect.stringContaining('ADS_MANAGE_FORBIDDEN') });
  });

  it('follows its account when the account moves to another legal entity, in every state, and nothing else changes', async () => {
    const r = await rig();
    const queued = await request(r, LOWER);
    const settled = await request(r, { kind: 'pause', slot: 'campaign' });
    await settle(r, settled, 'applied');
    const entity = (await rows<{ id: string }>(`INSERT INTO crove_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, 'Chi nhánh', 'branch', $2) RETURNING id`, [r.org.orgId, r.org.owner]))[0]?.id as string;
    const before = [await get(r, queued), await get(r, settled)];
    await admin((c) => c.query(`UPDATE crove_ads.ad_account SET legal_entity_id = $3 WHERE org_id = $1 AND id = $2`, [r.org.orgId, r.account, entity]));
    const moved = await rows<{ legal_entity_id: string }>(`SELECT legal_entity_id FROM crove_ads.ad_manage_change WHERE org_id = $1 AND ad_account_id = $2`, [r.org.orgId, r.account]);
    expect(moved.map((m) => m.legal_entity_id)).toEqual([entity, entity]);
    expect([await get(r, queued), await get(r, settled)]).toEqual(before);
  });

  it('judges a plan against every other launch with launch_commitments_except, the changes included, and shows it to owners, admins and the system alone', async () => {
    const r = await rig();
    const raise = await approved<{ id: string }>(r, RAISE, { commit: true });
    expect(raise.id).toBeTruthy();
    const except = (who: Who, launch: string | null) =>
      inContext(r.org, who, async (c) => (await c.query<{ ad_account_id: string; daily_budget: string }>(`SELECT ad_account_id, daily_budget FROM crove_ads.launch_commitments_except('VND', $1::date, $2::date, $3::uuid)`, [D(-30), D(300), launch])).rows);
    // A launch with a raise answers a row a day: the days before the raise was asked for at the old budget, the days after at the raised one.
    expect([...new Set((await except('owner', null)).map((x) => x.daily_budget))].sort()).toEqual(['100000', '150000']);
    expect(await except('admin', r.launch)).toEqual([]);
    expect([...new Set((await except('system', randomUUID())).map((x) => x.daily_budget))].sort()).toEqual(['100000', '150000']);
    for (const who of ['member', 'viewer'] as const) {
      await inContext(r.org, who, (c) => refused(c, `SELECT * FROM crove_ads.launch_commitments_except('VND', $1::date, $2::date, NULL)`, [D(-30), D(300)], 'ADS_LAUNCH_FORBIDDEN'));
      await inContext(r.org, who, (c) => refused(c, `SELECT * FROM crove_ads.launch_commitments('VND', $1::date, $2::date)`, [D(-30), D(300)], 'ADS_LAUNCH_FORBIDDEN'));
    }
    // Another org's launches are never in the answer. The other org's launch holds the same budget (100 000) as this one's, so the set of budgets cannot show a leak: the rows
    // are compared before and after the other org exists, and every row is this org's own account.
    const own = await except('owner', null);
    const other = await rig();
    const after = await except('owner', null);
    expect(after).toEqual(own);
    expect(new Set(after.map((x) => x.ad_account_id))).toEqual(new Set([r.account]));
    expect(after.some((x) => x.ad_account_id === other.account)).toBe(false);
    expect((await inContext(other.org, 'owner', async (c) => (await c.query(`SELECT * FROM crove_ads.launch_commitments('VND', $1::date, $2::date)`, [D(-30), D(300)])).rows)).length).toBe(1);
  });

  it('shows a change to the org that made it and to no other: an owner of another org reads and writes none of these rows', async () => {
    const a = await rig();
    const b = await rig();
    const id = await request(a, LOWER);
    const seen = (r: Rig) => inContext(r.org, 'owner', async (c) => (await c.query<{ id: string }>(`SELECT id FROM crove_ads.ad_manage_change`)).rows.map((x) => x.id));
    expect(await seen(a)).toEqual([id]);
    expect(await seen(b)).toEqual([]);
    // The other org's owner cannot settle or cancel it, and an insert of a row of this org from the other's context is refused by row security.
    await inContext(b.org, 'owner', async (c) => expect((await c.query(`UPDATE crove_ads.ad_manage_change SET state = 'cancelled' WHERE id = $1`, [id])).rowCount).toBe(0));
    const [text, params] = defaults(a, { kind: 'pause' });
    await inContext(b.org, 'owner', (c) => expect(c.query(text, params)).rejects.toBeTruthy());
    expect((await get(a, id))?.state).toBe('queued');
    expect((await rows<{ n: string }>(`SELECT count(*)::text AS n FROM crove_ads.ad_manage_change WHERE org_id = $1`, [a.org.orgId]))[0]?.n).toBe('1');
  });

  it('is run by no agent and by none of the commands outside their roles: an agent, a member and a viewer get FORBIDDEN, and the job’s two commands are the system’s alone', async () => {
    const r = await rig();
    const agent = { type: 'agent' as const, agentId: randomUUID(), onBehalfOf: r.org.owner } as never;
    for (const [name, input] of [
      ['ads.object.pause', { launchId: r.launch, slot: 'ad_1' }],
      ['ads.object.archive', { launchId: r.launch, slot: 'ad_1' }],
      ['ads.budget.lower', { launchId: r.launch, dailyBudget: '60000' }],
      ['ads.schedule.shorten', { launchId: r.launch, endOn: D(5) }],
      ['ads.manage.cancel', { changeId: randomUUID() }],
      ['ads.object.prepare_resume', { launchId: r.launch, slot: 'ad_1' }],
      ['ads.budget.prepare_raise', { launchId: r.launch, dailyBudget: '150000' }],
      ['ads.schedule.prepare_extend', { launchId: r.launch, endOn: D(20) }],
    ] as const) {
      await expect(runtime.execute(name, input, { actor: agent, orgId: r.org.orgId }), `${name} as an agent`).rejects.toMatchObject({ status: 403 });
      for (const who of ['member', 'viewer'] as const) {
        await expect(runtime.execute(name, input, { actor: { type: 'user', userId: r.org[who], aal: 'aal1' }, orgId: r.org.orgId }), `${name} as a ${who}`).rejects.toMatchObject({ status: 403 });
      }
    }
    for (const [name, input] of [
      ['ads.manage.begin', { changeId: randomUUID(), providers: [] }],
      ['ads.manage.record', { changeId: randomUUID(), callKey: 'x', phase: 'call', result: { kind: 'accepted' } }],
    ] as const) {
      for (const actor of [agent, { type: 'user' as const, userId: r.org.owner, aal: 'aal1' as const }, { type: 'user' as const, userId: r.org.admin, aal: 'aal1' as const }]) {
        await expect(runtime.execute(name, input, { actor, orgId: r.org.orgId }), name).rejects.toMatchObject({ status: 403 });
      }
    }
    // A raise, a resume and an extension run only inside an approval: never called directly, by an owner or the system. The payloads are VALID ones for this very launch (they would
    // pass the approval path), so the refusal can only be the missing approval, not a payload the command could not read.
    const base = { launchId: r.launch, adAccountId: r.account, adAccountName: 'Thử', campaignName: 'Thử', currency: 'VND', startOn: r.start, previousAmount: String(100000 * 14) };
    for (const [name, payload] of [
      ['ads.object.resume', { ...base, slot: 'ad_1', objectName: 'Thử ad', dailyBudget: '100000', endOn: r.end, amount: String(100000 * 14) }],
      ['ads.budget.raise', { ...base, slot: 'ad_set', fromBudget: '100000', toBudget: '150000', endOn: r.end, amount: String(150000 * 14) }],
      ['ads.schedule.extend', { ...base, slot: 'ad_set', dailyBudget: '100000', fromEndOn: r.end, toEndOn: D(20), amount: String(100000 * 24) }],
    ] as const) {
      for (const actor of [{ type: 'user' as const, userId: r.org.owner, aal: 'aal1' as const }, { type: 'system' as const, component: 'test' }]) {
        const refusal = await runtime.execute(name, { payload }, { actor, orgId: r.org.orgId }).then(() => null, (e: unknown) => e as { code?: string; status?: number });
        // The runtime refuses a proposal-only command called outside the approval path (access 'proposal'), before the handler reads the payload.
        expect(refusal, `${name} as ${actor.type}`).toMatchObject({ code: 'FORBIDDEN', status: 403 });
      }
    }
    expect((await rows<{ n: string }>(`SELECT count(*)::text AS n FROM crove_ads.ad_manage_change WHERE org_id = $1`, [r.org.orgId]))[0]?.n).toBe('0');
  });
});

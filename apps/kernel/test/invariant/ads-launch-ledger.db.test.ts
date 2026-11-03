// SPDX-License-Identifier: AGPL-3.0-only
// The launch ledger of running ads (W2-2, issue #2296, ADR-0043 point 2, plan docs/plan/ads-write.md sections 3.3 and 9; step one of the invariant route is the
// RLS matrix factory of #2527): a row per approved plan holding the commitment it makes against the spend caps. Each condition is a test here, against a real
// PostgreSQL, in SQL where the claim is about the database and not about a command:
//   1. tenant roles read the ledger and update its state columns only; none deletes or truncates; the guard is a definer that fires for every role;
//   2. a launch row exists only inside the execution of the approved proposal of its plan: no context of the org (an owner, an admin, a member, the system,
//      the table's owner too) inserts one without it;
//   3. the commitment is arithmetic the table holds whoever writes (the amount is the budget times the days, a flight is at most 90 days, the window holds
//      the commitment, one launch per draft) and the plan never changes;
//   4. a state moves only along its graph, by the right actor (the writer's moves are the system's; a person cancels or stops), the attempts are counted by
//      the guard, a final state never changes, and the commitment only shortens and is cleared when it is cancelled;
//   5. what a plan is checked against (launch_commitments) is every launch that still commits, of the org in context, for owners, admins and the system;
//   6. the spend caps stay an append-only history, the switches stay the owner's at the database, and the approval of a launch is judged on the people of
//      the org now (one eligible person: self-approved; two: four-eyes).
// Keep this directory self-contained: import code under test, not fixtures from outside it. Set CROVE_TEST_ADMIN_URL to a superuser URL; the run creates and drops
// its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, liveApprovalCommands, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const HASH = `sha256:${'a'.repeat(64)}`;
const STATE_COLUMNS = ['state', 'attempt', 'step', 'commit_until', 'stop_reason', 'updated_by', 'updated_at', 'started_at', 'finished_at'];

const suite = ADMIN ? describe : describe.skip;

type Who = 'owner' | 'admin' | 'member' | 'viewer' | 'system';
interface Org {
  orgId: string;
  owner: string;
  admin: string;
  member: string;
  viewer: string;
}

suite('the launch ledger of running ads (#2296, W2-2)', () => {
  const dbName = `crove_test_adslaunch_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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
    return upsertIdentity(createDb(pool), { issuer: 'test', subject: `${name}-${tag}`, email: `${name}-${tag}@launch.test`, name: null });
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

  // An ad account with a draft and a queued launch of 100 000 a day for ten days (as the table's owner, outside any context, as a definer would).
  async function launch(org: Org, options: { daily?: string; start?: string; end?: string; currency?: string; account?: string } = {}) {
    const daily = options.daily ?? '100000';
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
      await owner(`INSERT INTO crove_ads.ad_account (org_id, id, channel_connection_id, provider, external_account_id, name, backfill_from, currency) VALUES ($1, $2, $3, 'sandbox_ads', $4, 'Thử', '2025-10-01', $5)`, [
        org.orgId,
        account,
        connection,
        `acct-${connection.slice(0, 8)}`,
        options.currency ?? 'VND',
      ]);
    }
    const draft = randomUUID();
    await owner(`INSERT INTO crove_ads.ad_campaign_draft (org_id, id, ad_account_id, name, objective, created_by) VALUES ($1, $2, $3, 'Thử', 'traffic', $4)`, [org.orgId, draft, account, org.owner]);
    const id = randomUUID();
    await owner(
      `INSERT INTO crove_ads.ad_launch (org_id, id, ad_account_id, draft_id, proposal_id, plan_hash, currency, daily_budget, start_on, end_on, amount, commit_until, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $10, $12)`,
      [org.orgId, id, account, draft, randomUUID(), HASH, options.currency ?? 'VND', daily, start, end, String(Number(daily) * days), org.owner],
    );
    return { id, account, draft, start, end };
  }
  const get = async (org: Org, id: string) =>
    (
      await rows<{ state: string; attempt: number; step: string | null; commit_until: string | null; stop_reason: string | null; started_at: Date | null; finished_at: Date | null; updated_by: string | null }>(
        `SELECT state, attempt, step, commit_until::text, stop_reason, started_at, finished_at, updated_by FROM crove_ads.ad_launch WHERE org_id = $1 AND id = $2`,
        [org.orgId, id],
      )
    )[0];
  const move = (c: pg.Client, org: Org, id: string, set: string) => c.query(`UPDATE crove_ads.ad_launch SET ${set} WHERE org_id = $1 AND id = $2`, [org.orgId, id]);

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

  it('gives tenant roles the ledger to read and its state columns to update, no delete, and holds it with a definer guard that fires for every role', async () => {
    const roles = ['crove_app', 'crove_worker', 'crove_tenant'];
    const priv = await rows<{ role: string; select: boolean; insert: boolean; update: boolean; del: boolean; truncate: boolean }>(
      `SELECT r AS role, has_table_privilege(r, 'crove_ads.ad_launch', 'SELECT') AS select, has_table_privilege(r, 'crove_ads.ad_launch', 'INSERT') AS insert,
              has_table_privilege(r, 'crove_ads.ad_launch', 'UPDATE') AS update, has_table_privilege(r, 'crove_ads.ad_launch', 'DELETE') AS del, has_table_privilege(r, 'crove_ads.ad_launch', 'TRUNCATE') AS truncate
       FROM unnest($1::text[]) r`,
      [roles],
    );
    for (const p of priv) expect(p, p.role).toMatchObject({ select: true, update: false, del: false, truncate: false });
    // The columns a role may update are the state columns and nothing of the plan.
    const granted = await rows<{ column_name: string }>(
      `SELECT a.attname AS column_name FROM pg_attribute a WHERE a.attrelid = 'crove_ads.ad_launch'::regclass AND a.attnum > 0 AND NOT a.attisdropped AND has_column_privilege('crove_tenant', a.attrelid, a.attnum, 'UPDATE') ORDER BY 1`,
    );
    expect(granted.map((g) => g.column_name)).toEqual([...STATE_COLUMNS].sort());
    // The guard: a trigger for insert and update, enabled for every role (a replica role does not skip it), of a definer with a pinned search path that no login role runs.
    const guard = await rows<{ enabled: string; definer: boolean; config: string[] | null; app: boolean; worker: boolean }>(
      `SELECT t.tgenabled AS enabled, p.prosecdef AS definer, p.proconfig AS config, has_function_privilege('crove_app', p.oid, 'EXECUTE') AS app, has_function_privilege('crove_worker', p.oid, 'EXECUTE') AS worker
       FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid WHERE t.tgrelid = 'crove_ads.ad_launch'::regclass AND t.tgname = 'launch_guard'`,
    );
    expect(guard).toEqual([{ enabled: 'A', definer: true, config: ['search_path=pg_catalog, pg_temp'], app: false, worker: false }]);
    // What a plan is checked against is answered to the app's and the worker's logins alone.
    const marker = await rows<{ app: boolean; worker: boolean; tenant: boolean; pub: boolean }>(
      `SELECT has_function_privilege('crove_app', f, 'EXECUTE') AS app, has_function_privilege('crove_worker', f, 'EXECUTE') AS worker, has_function_privilege('crove_tenant', f, 'EXECUTE') AS tenant,
              EXISTS (SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x WHERE p.oid = f AND x.grantee = 0) AS pub
       FROM (SELECT 'crove_ads.launch_commitments(text, date, date)'::regprocedure AS f) q`,
    );
    expect(marker).toEqual([{ app: true, worker: true, tenant: false, pub: false }]);
  });

  it('lets no context of the org insert a launch without the approved proposal of its plan, the table’s owner included', async () => {
    const org = await makeOrg();
    const { account, draft } = await launch(org);
    const insert = `INSERT INTO crove_ads.ad_launch (org_id, ad_account_id, draft_id, proposal_id, plan_hash, currency, daily_budget, start_on, end_on, amount, created_by)
                    VALUES ($1, $2, $3, $4, $5, 'VND', '100000', '2031-04-01', '2031-04-10', '1000000', $6)`;
    for (const who of ['owner', 'admin', 'member', 'viewer', 'system'] as const) {
      // A fresh draft each time (one launch per draft), so the refusal is the guard's and not a key's.
      const fresh = randomUUID();
      await owner(`INSERT INTO crove_ads.ad_campaign_draft (org_id, id, ad_account_id, name, objective, created_by) VALUES ($1, $2, $3, 'Thử', 'traffic', $4)`, [org.orgId, fresh, account, org.owner]);
      await inContext(org, who, (c) => refused(c, insert, [org.orgId, account, fresh, randomUUID(), HASH, org.owner], 'ADS_LAUNCH_FORBIDDEN'));
    }
    // The table's owner (a superuser here) in the system's context is held too: the guard fires for every role, and nothing outside an approved execution passes.
    const viaOwner = randomUUID();
    await owner(`INSERT INTO crove_ads.ad_campaign_draft (org_id, id, ad_account_id, name, objective, created_by) VALUES ($1, $2, $3, 'Thử', 'traffic', $4)`, [org.orgId, viaOwner, account, org.owner]);
    await admin(async (c) => {
      await c.query('BEGIN');
      try {
        await c.query('SELECT crove_kernel.enter_system_context($1::uuid)', [org.orgId]);
        await refused(c, insert, [org.orgId, account, viaOwner, randomUUID(), HASH, org.owner], 'ADS_LAUNCH_FORBIDDEN');
      } finally {
        await c.query('ROLLBACK').catch(() => undefined);
      }
    });
    // The draft the launch names, even approved, does not make one: no proposal, no row (the draft is only a draft here, so the refusal is the first of the guard's).
    expect((await rows<{ n: string }>(`SELECT count(*)::text AS n FROM crove_ads.ad_launch WHERE org_id = $1 AND draft_id = $2`, [org.orgId, draft])).map((r) => r.n)).toEqual(['1']);
  });

  it('holds the commitment as arithmetic whoever writes: the amount is the budget times the days, a flight is at most 90 days, the window holds it, one launch per draft', async () => {
    const org = await makeOrg();
    const base = await launch(org);
    const draft = async () => {
      const id = randomUUID();
      await owner(`INSERT INTO crove_ads.ad_campaign_draft (org_id, id, ad_account_id, name, objective, created_by) VALUES ($1, $2, $3, 'Thử', 'traffic', $4)`, [org.orgId, id, base.account, org.owner]);
      return id;
    };
    const raw = async (set: Record<string, string>) => {
      const v = { daily_budget: '100000', start_on: '2031-05-01', end_on: '2031-05-10', amount: '1000000', commit_until: '2031-05-10', plan_hash: HASH, currency: 'VND', ...set };
      return owner(
        `INSERT INTO crove_ads.ad_launch (org_id, ad_account_id, draft_id, proposal_id, plan_hash, currency, daily_budget, start_on, end_on, amount, commit_until, created_by, state, finished_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, ${set.state ? `'${set.state}'` : "'queued'"}, ${set.state === 'stopped' || set.state === 'failed' ? 'now()' : 'NULL'})`,
        [org.orgId, base.account, await draft(), randomUUID(), v.plan_hash, v.currency, v.daily_budget, v.start_on, v.end_on, v.amount, v.commit_until === 'null' ? null : v.commit_until, org.owner],
      );
    };
    expect(await raw({})).toBe(1);
    await expect(raw({ amount: '999999' }), 'the amount is not the budget times the days').rejects.toMatchObject({ code: '23514', constraint: 'ad_launch_flight_ck' });
    await expect(raw({ end_on: '2031-08-01', commit_until: '2031-08-01', amount: '9300000' }), 'a flight of more than 90 days').rejects.toMatchObject({ code: '23514', constraint: 'ad_launch_flight_ck' });
    await expect(raw({ end_on: '2031-04-30', commit_until: '2031-04-30', amount: '0' }), 'an end before the start').rejects.toMatchObject({ code: '23514' });
    await expect(raw({ commit_until: '2031-05-11' }), 'a commitment past the flight').rejects.toMatchObject({ code: '23514', constraint: 'ad_launch_commit_ck' });
    await expect(raw({ commit_until: '2031-04-30' }), 'a commitment before the flight').rejects.toMatchObject({ code: '23514', constraint: 'ad_launch_commit_ck' });
    await expect(raw({ commit_until: 'null' }), 'a launch that is not over commits its budget').rejects.toMatchObject({ code: '23514', constraint: 'ad_launch_open_ck' });
    await expect(raw({ state: 'stopped', commit_until: 'null' }), 'a stopped launch with a finish time and nothing committed is fine').resolves.toBe(1);
    await expect(raw({ plan_hash: 'a'.repeat(64) }), 'the hash is the proposal’s, sha256: and 64 hex').rejects.toMatchObject({ code: '23514' });
    await expect(raw({ currency: 'vnd' })).rejects.toMatchObject({ code: '23514' });
    await expect(raw({ daily_budget: 'NaN', amount: 'NaN' })).rejects.toMatchObject({ code: '23514' });
    // One launch per draft, and the name tag is generated from the id: `ludy:` and ten hex characters, never written.
    await expect(
      owner(`INSERT INTO crove_ads.ad_launch (org_id, ad_account_id, draft_id, proposal_id, plan_hash, currency, daily_budget, start_on, end_on, amount, commit_until, created_by) VALUES ($1, $2, $3, $4, $5, 'VND', '1', '2031-05-01', '2031-05-01', '1', '2031-05-01', $6)`, [
        org.orgId,
        base.account,
        base.draft,
        randomUUID(),
        HASH,
        org.owner,
      ]),
    ).rejects.toMatchObject({ code: '23505', constraint: 'ad_launch_draft_uq' });
    const tag = (await get(org, base.id)) && (await rows<{ tag: string }>(`SELECT tag FROM crove_ads.ad_launch WHERE org_id = $1 AND id = $2`, [org.orgId, base.id]))[0]?.tag;
    expect(tag).toMatch(/^ludy:[0-9a-f]{10}$/);
    await expect(owner(`UPDATE crove_ads.ad_launch SET tag = 'ludy:0000000000' WHERE org_id = $1 AND id = $2`, [org.orgId, base.id])).rejects.toMatchObject({ code: '428C9' });
    // The plan never changes, whoever writes (the table's owner in no context too).
    for (const [column, value] of [['daily_budget', '1'], ['start_on', "'2031-03-02'"], ['end_on', "'2031-03-09'"], ['amount', '1'], ['plan_hash', `'sha256:${'b'.repeat(64)}'`], ['currency', "'USD'"], ['proposal_id', 'gen_random_uuid()'], ['draft_id', 'gen_random_uuid()'], ['created_by', 'gen_random_uuid()']] as const) {
      await expect(owner(`UPDATE crove_ads.ad_launch SET ${column} = ${value} WHERE org_id = $1 AND id = $2`, [org.orgId, base.id]), column).rejects.toMatchObject({ code: expect.stringMatching(/^(42501|23503|23514)$/) });
    }
    // A launch goes with its account (and its draft): the org's purge deletes the ledger that way.
    const gone = await launch(org);
    await owner(`DELETE FROM crove_ads.ad_account WHERE org_id = $1 AND id = $2`, [org.orgId, gone.account]);
    expect(await get(org, gone.id)).toBeUndefined();
  });

  it('moves a state only along its graph, the writer’s moves by the system and the stop by a person or the system, and counts the attempts itself', async () => {
    const org = await makeOrg();
    // Cancelling a queued launch: an owner or an admin, never a member or a viewer; it clears the commitment and stamps the finish.
    const forMember = await launch(org);
    const forViewer = await launch(org);
    for (const [who, l] of [['member', forMember], ['viewer', forViewer]] as const) await inContext(org, who, (c) => refused(c, `UPDATE crove_ads.ad_launch SET state = 'cancelled' WHERE org_id = $1 AND id = $2`, [org.orgId, l.id], 'ADS_LAUNCH_FORBIDDEN'));
    const byOwner = await launch(org);
    await inContext(org, 'owner', (c) => move(c, org, byOwner.id, `state = 'cancelled'`), true);
    expect(await get(org, byOwner.id)).toMatchObject({ state: 'cancelled', commit_until: null, stop_reason: 'cancelled', updated_by: org.owner });
    expect((await get(org, byOwner.id))?.finished_at).toBeInstanceOf(Date);
    const byAdmin = await launch(org);
    await inContext(org, 'admin', (c) => move(c, org, byAdmin.id, `state = 'cancelled', stop_reason = 'switch_off', commit_until = '2031-03-05'`), true);
    // A cancelled launch commits nothing, whatever the writer sent.
    expect(await get(org, byAdmin.id)).toMatchObject({ state: 'cancelled', commit_until: null, stop_reason: 'switch_off' });
    // The writer's moves are not a person's: an owner does not start a launch, set its step or mark it live.
    const run = await launch(org);
    await inContext(org, 'owner', (c) => refused(c, `UPDATE crove_ads.ad_launch SET state = 'launching' WHERE org_id = $1 AND id = $2`, [org.orgId, run.id], 'ADS_LAUNCH_FORBIDDEN'));
    await inContext(org, 'owner', (c) => refused(c, `UPDATE crove_ads.ad_launch SET step = 'campaign' WHERE org_id = $1 AND id = $2`, [org.orgId, run.id], 'ADS_LAUNCH_FORBIDDEN'));
    await inContext(org, 'admin', (c) => refused(c, `UPDATE crove_ads.ad_launch SET state = 'live' WHERE org_id = $1 AND id = $2`, [org.orgId, run.id], 'ADS_LAUNCH_STATE'));
    // The graph: queued to live is no move; the system starts it, stamps the start and keeps the attempt.
    await inContext(org, 'system', (c) => refused(c, `UPDATE crove_ads.ad_launch SET state = 'live' WHERE org_id = $1 AND id = $2`, [org.orgId, run.id], 'ADS_LAUNCH_STATE'));
    await inContext(org, 'system', (c) => move(c, org, run.id, `state = 'launching', step = 'campaign'`), true);
    expect(await get(org, run.id)).toMatchObject({ state: 'launching', step: 'campaign', attempt: 1 });
    expect((await get(org, run.id))?.started_at).toBeInstanceOf(Date);
    // A person does not move a launch the writer has started, but stopping it is theirs: the member no, the admin yes.
    await inContext(org, 'member', (c) => refused(c, `UPDATE crove_ads.ad_launch SET state = 'stopped' WHERE org_id = $1 AND id = $2`, [org.orgId, run.id], 'ADS_LAUNCH_FORBIDDEN'));
    await inContext(org, 'admin', (c) => refused(c, `UPDATE crove_ads.ad_launch SET state = 'cancelled' WHERE org_id = $1 AND id = $2`, [org.orgId, run.id], 'ADS_LAUNCH_STATE'));
    // Needs attention and the retry: the attempt goes up by one, by the guard's rule, and never otherwise.
    await inContext(org, 'system', (c) => move(c, org, run.id, `state = 'needs_attention'`), true);
    await inContext(org, 'system', (c) => refused(c, `UPDATE crove_ads.ad_launch SET state = 'launching' WHERE org_id = $1 AND id = $2`, [org.orgId, run.id], 'ADS_LAUNCH_FORBIDDEN'));
    await inContext(org, 'system', (c) => refused(c, `UPDATE crove_ads.ad_launch SET state = 'launching', attempt = 3 WHERE org_id = $1 AND id = $2`, [org.orgId, run.id], 'ADS_LAUNCH_FORBIDDEN'));
    await inContext(org, 'system', (c) => move(c, org, run.id, `state = 'launching', attempt = 2`), true);
    expect(await get(org, run.id)).toMatchObject({ state: 'launching', attempt: 2 });
    await inContext(org, 'system', (c) => refused(c, `UPDATE crove_ads.ad_launch SET attempt = 3 WHERE org_id = $1 AND id = $2`, [org.orgId, run.id], 'ADS_LAUNCH_FORBIDDEN'));
    await inContext(org, 'system', (c) => move(c, org, run.id, `state = 'live', step = 'activate'`), true);
    await inContext(org, 'system', (c) => refused(c, `UPDATE crove_ads.ad_launch SET state = 'queued' WHERE org_id = $1 AND id = $2`, [org.orgId, run.id], 'ADS_LAUNCH_STATE'));
    // The writer cannot stamp the start or the finish: the guard does.
    await inContext(org, 'system', (c) => refused(c, `UPDATE crove_ads.ad_launch SET finished_at = now() WHERE org_id = $1 AND id = $2`, [org.orgId, run.id], 'ADS_LAUNCH_FORBIDDEN'));
    // Live to stopped: a person's or the system's, with the commitment shortened to what ran, never cleared; a person does not set the writer's step on the way;
    // and a stopped launch never changes again, but a no-op passes.
    for (const who of ['owner', 'admin', 'system'] as const) {
      await inContext(org, who, (c) => refused(c, `UPDATE crove_ads.ad_launch SET state = 'stopped', commit_until = NULL WHERE org_id = $1 AND id = $2`, [org.orgId, run.id], 'ADS_LAUNCH_FORBIDDEN'));
    }
    await inContext(org, 'owner', (c) => refused(c, `UPDATE crove_ads.ad_launch SET state = 'stopped', commit_until = '2031-03-04', step = 'ad' WHERE org_id = $1 AND id = $2`, [org.orgId, run.id], 'ADS_LAUNCH_FORBIDDEN'));
    // A context with no role (the table's owner in no context, as a raw statement) is no stop either: the check is written so a NULL role cannot pass.
    await expect(owner(`UPDATE crove_ads.ad_launch SET state = 'stopped', commit_until = '2031-03-04' WHERE org_id = $1 AND id = $2`, [org.orgId, run.id])).rejects.toMatchObject({ code: '42501', message: expect.stringContaining('ADS_LAUNCH_FORBIDDEN') });
    await expect(owner(`UPDATE crove_ads.ad_launch SET state = 'cancelled' WHERE org_id = $1 AND id = $2`, [org.orgId, (await launch(org)).id])).rejects.toMatchObject({ code: '42501', message: expect.stringContaining('ADS_LAUNCH_FORBIDDEN') });
    await inContext(org, 'owner', (c) => move(c, org, run.id, `state = 'stopped', commit_until = '2031-03-04', stop_reason = 'paused'`), true);
    expect(await get(org, run.id)).toMatchObject({ state: 'stopped', commit_until: '2031-03-04', stop_reason: 'paused', attempt: 2 });
    for (const set of [`state = 'live'`, `commit_until = '2031-03-09'`, `step = 'ad'`, `stop_reason = 'x'`]) {
      await inContext(org, 'system', (c) => refused(c, `UPDATE crove_ads.ad_launch SET ${set} WHERE org_id = $1 AND id = $2`, [org.orgId, run.id], 'ADS_LAUNCH_FROZEN'));
    }
    await inContext(org, 'member', async (c) => expect((await move(c, org, run.id, `step = step`)).rowCount).toBe(1), true);
  });

  // The tenant roles hold UPDATE on the state columns (a cancel is made through them), so the guard is what keeps a member or a viewer from moving what counts
  // against the caps: every change of a state column, from every state, is refused to them, at the database.
  it('refuses a member and a viewer every change of a state column, from every state: a state, a step, an attempt, a commitment, a stop reason, a time', async () => {
    const org = await makeOrg();
    const states = ['queued', 'launching', 'needs_attention', 'live', 'stopped', 'failed', 'cancelled'] as const;
    // A launch in each state, made the way it is made: by the system along the graph (and a person's stop for the cancelled).
    const inState = async (state: (typeof states)[number]) => {
      const l = await launch(org);
      const path: Record<string, string[]> = {
        queued: [],
        launching: [`state = 'launching'`],
        needs_attention: [`state = 'launching'`, `state = 'needs_attention'`],
        live: [`state = 'launching'`, `state = 'live'`],
        stopped: [`state = 'launching'`, `state = 'live'`, `state = 'stopped', commit_until = '2031-03-04'`],
        failed: [`state = 'launching'`, `state = 'failed', commit_until = NULL`],
        cancelled: [`state = 'cancelled'`],
      };
      for (const set of path[state] ?? []) await inContext(org, state === 'cancelled' ? 'owner' : 'system', (c) => move(c, org, l.id, set), true);
      expect((await get(org, l.id))?.state).toBe(state);
      return l;
    };
    for (const state of states) {
      const l = await inState(state);
      const changes = [
        ...states.filter((s) => s !== state).map((s) => `state = '${s}'`),
        `state = '${state}', commit_until = '2031-03-02'`,
        `commit_until = '2031-03-02'`,
        `commit_until = '2031-03-10'`,
        `commit_until = NULL`,
        `step = 'activate'`,
        `step = NULL`,
        `attempt = attempt + 1`,
        `attempt = 20`,
        `stop_reason = 'x'`,
        `started_at = now()`,
        `finished_at = now()`,
        `finished_at = NULL`,
      ];
      const before = await get(org, l.id);
      // A statement that sets a column to the value it has changes nothing (the guard lets it through, as any no-op), so it is not an illegal change.
      const sameAsNow = (set: string) =>
        (set === 'step = NULL' && before?.step === null) ||
        (set === 'finished_at = NULL' && before?.finished_at === null) ||
        (set === 'commit_until = NULL' && before?.commit_until === null) ||
        (set === `commit_until = '2031-03-10'` && before?.commit_until === '2031-03-10');
      for (const who of ['member', 'viewer'] as const) {
        for (const set of changes.filter((s) => !sameAsNow(s))) {
          await inContext(org, who, (c) => expect(c.query(`UPDATE crove_ads.ad_launch SET ${set} WHERE org_id = $1 AND id = $2`, [org.orgId, l.id]), `${who} from ${state}: ${set}`).rejects.toMatchObject({ code: expect.stringMatching(/^(42501|23514)$/) }));
        }
        // No delete, no truncate, no insert of a copy; and the plan's columns are not theirs to write at all (a privilege error, before any guard).
        await inContext(org, who, (c) => expect(c.query(`DELETE FROM crove_ads.ad_launch WHERE org_id = $1 AND id = $2`, [org.orgId, l.id])).rejects.toMatchObject({ code: '42501' }));
        await inContext(org, who, (c) => expect(c.query(`UPDATE crove_ads.ad_launch SET daily_budget = 1 WHERE org_id = $1 AND id = $2`, [org.orgId, l.id])).rejects.toMatchObject({ code: '42501' }));
      }
      // The stamps are the database's: what a member writes into them is ignored, and nothing else of the row changes.
      await inContext(org, 'member', (c) => move(c, org, l.id, `updated_by = gen_random_uuid(), updated_at = '2000-01-01'`), true);
      expect(await get(org, l.id)).toEqual(before);
    }
  });

  it('lets a commitment only shorten: never later, never back after it was cleared, and never past the plan’s own days', async () => {
    const org = await makeOrg();
    const l = await launch(org);
    await inContext(org, 'system', (c) => move(c, org, l.id, `state = 'launching'`), true);
    await inContext(org, 'system', (c) => move(c, org, l.id, `state = 'live'`), true);
    // Shortened by the system (a person's stop does it with the move to stopped): earlier is accepted, later is not, before the first day is not a window.
    await inContext(org, 'system', (c) => move(c, org, l.id, `commit_until = '2031-03-07'`), true);
    expect((await get(org, l.id))?.commit_until).toBe('2031-03-07');
    await inContext(org, 'system', (c) => refused(c, `UPDATE crove_ads.ad_launch SET commit_until = '2031-03-09' WHERE org_id = $1 AND id = $2`, [org.orgId, l.id], 'ADS_LAUNCH_FORBIDDEN'));
    await inContext(org, 'system', (c) => expect(move(c, org, l.id, `commit_until = '2031-02-28'`)).rejects.toMatchObject({ code: '23514', constraint: 'ad_launch_commit_ck' }));
    // A person does not change it without a move, and an open launch cannot clear it (the table's own check).
    await inContext(org, 'owner', (c) => refused(c, `UPDATE crove_ads.ad_launch SET commit_until = '2031-03-05' WHERE org_id = $1 AND id = $2`, [org.orgId, l.id], 'ADS_LAUNCH_FORBIDDEN'));
    await inContext(org, 'system', (c) => expect(move(c, org, l.id, `commit_until = NULL`)).rejects.toMatchObject({ code: '23514', constraint: 'ad_launch_open_ck' }));
    // A launch that ran is stopped with what ran committed, never cleared; one that failed before it was activated commits nothing any more, and it never comes back.
    await inContext(org, 'system', (c) => refused(c, `UPDATE crove_ads.ad_launch SET state = 'stopped', commit_until = NULL WHERE org_id = $1 AND id = $2`, [org.orgId, l.id], 'ADS_LAUNCH_FORBIDDEN'));
    const failed = await launch(org);
    await inContext(org, 'system', (c) => move(c, org, failed.id, `state = 'launching'`), true);
    await inContext(org, 'system', (c) => move(c, org, failed.id, `state = 'failed', commit_until = NULL`), true);
    expect(await get(org, failed.id)).toMatchObject({ state: 'failed', commit_until: null });
    await inContext(org, 'system', (c) => move(c, org, l.id, `state = 'stopped', commit_until = '2031-03-07'`), true);
    expect(await get(org, l.id)).toMatchObject({ state: 'stopped', commit_until: '2031-03-07' });
  });

  it('follows its account when the account moves to another legal entity, whatever state the launch is in, and nothing else changes', async () => {
    const org = await makeOrg();
    const queued = await launch(org);
    const cancelled = await launch(org, { account: queued.account });
    await inContext(org, 'owner', (c) => move(c, org, cancelled.id, `state = 'cancelled'`), true);
    const entity = (await rows<{ id: string }>(`INSERT INTO crove_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, 'Chi nhánh', 'branch', $2) RETURNING id`, [org.orgId, org.owner]))[0]?.id as string;
    const before = [await get(org, queued.id), await get(org, cancelled.id)];
    await owner(`UPDATE crove_ads.ad_account SET legal_entity_id = $3 WHERE org_id = $1 AND id = $2`, [org.orgId, queued.account, entity]);
    const moved = await rows<{ legal_entity_id: string }>(`SELECT legal_entity_id FROM crove_ads.ad_launch WHERE org_id = $1 AND ad_account_id = $2`, [org.orgId, queued.account]);
    expect(moved.map((m) => m.legal_entity_id)).toEqual([entity, entity]);
    expect([await get(org, queued.id), await get(org, cancelled.id)]).toEqual(before);
  });

  it('answers the commitments of the org in context, for owners, admins and the system alone: the launches that still commit, in the window and the currency, of every account', async () => {
    const org = await makeOrg();
    const other = await makeOrg();
    const a = await launch(org, { start: '2031-06-01', end: '2031-06-10' });
    const b = await launch(org, { start: '2031-06-05', end: '2031-06-20', daily: '50000' });
    const usd = await launch(org, { start: '2031-06-01', end: '2031-06-10', currency: 'USD', daily: '10' });
    const cancelled = await launch(org, { start: '2031-06-01', end: '2031-06-10' });
    await inContext(org, 'owner', (c) => move(c, org, cancelled.id, `state = 'cancelled'`), true);
    const elsewhere = await launch(other, { start: '2031-06-01', end: '2031-06-10' });
    const later = await launch(org, { start: '2031-09-01', end: '2031-09-10' });
    const ask = (who: Who, currency: string, from: string, to: string) =>
      inContext(org, who, async (c) => (await c.query<{ ad_account_id: string; daily_budget: string; start_on: string; commit_until: string }>(`SELECT ad_account_id, daily_budget, start_on::text, commit_until::text FROM crove_ads.launch_commitments($1, $2::date, $3::date)`, [currency, from, to])).rows);
    for (const who of ['owner', 'admin', 'system'] as const) {
      const got = await ask(who, 'VND', '2031-06-01', '2031-06-30');
      expect(got.map((r) => `${r.ad_account_id}:${r.daily_budget}:${r.start_on}:${r.commit_until}`).sort(), who).toEqual(
        [`${a.account}:100000:2031-06-01:2031-06-10`, `${b.account}:50000:2031-06-05:2031-06-20`].sort(),
      );
    }
    // The currency and the window decide: another currency, another month, and a window the launches do not touch.
    expect((await ask('owner', 'USD', '2031-06-01', '2031-06-30')).map((r) => r.ad_account_id)).toEqual([usd.account]);
    expect((await ask('owner', 'VND', '2031-09-01', '2031-09-30')).map((r) => r.ad_account_id)).toEqual([later.account]);
    expect(await ask('owner', 'VND', '2031-07-01', '2031-07-31')).toEqual([]);
    // Another org's launches are not the org's, and the others' commitments never show; a member, a viewer and no context are refused.
    expect((await ask('owner', 'VND', '2031-06-01', '2031-06-30')).map((r) => r.ad_account_id)).not.toContain(elsewhere.account);
    for (const who of ['member', 'viewer'] as const) await inContext(org, who, (c) => refused(c, `SELECT * FROM crove_ads.launch_commitments('VND', '2031-06-01', '2031-06-30')`, [], 'ADS_LAUNCH_FORBIDDEN'));
    await withClient(appUrl, (c) => expect(c.query(`SELECT * FROM crove_ads.launch_commitments('VND', '2031-06-01', '2031-06-30')`)).rejects.toMatchObject({ code: '42501', message: expect.stringContaining('NO_CONTEXT') }));
  });

  it('keeps the spend caps an append-only history, whoever asks, and the cap in force the newest row', async () => {
    const org = await makeOrg();
    const insert = `INSERT INTO crove_ads.ad_spend_cap (org_id, scope, period, amount, currency, set_by) VALUES ($1, 'org', 'daily', $2, 'VND', $3)`;
    // An owner inserts a cap; an admin, a member and the system are refused by the guard.
    await inContext(org, 'owner', (c) => c.query(insert, [org.orgId, '100', org.owner]), true);
    await inContext(org, 'owner', (c) => c.query(insert, [org.orgId, '200', org.owner]), true);
    for (const who of ['admin', 'member', 'system'] as const) await inContext(org, who, (c) => refused(c, insert, [org.orgId, '300', org.owner], 'ADS_CAP_FORBIDDEN'));
    // No login role changes or deletes a row of the history, an owner's context included.
    for (const who of ['owner', 'admin', 'system'] as const) {
      await inContext(org, who, (c) => expect(c.query(`UPDATE crove_ads.ad_spend_cap SET amount = 1 WHERE org_id = $1`, [org.orgId])).rejects.toMatchObject({ code: '42501' }));
      await inContext(org, who, (c) => expect(c.query(`DELETE FROM crove_ads.ad_spend_cap WHERE org_id = $1`, [org.orgId])).rejects.toMatchObject({ code: '42501' }));
    }
    // The cap in force is the newest row, whose id the database stamps: the rows are two, and the newest is the second.
    const history = await rows<{ amount: string }>(`SELECT amount::text FROM crove_ads.ad_spend_cap WHERE org_id = $1 ORDER BY id`, [org.orgId]);
    expect(history.map((h) => h.amount)).toEqual(['100', '200']);
  });

  it('keeps the switches the owner’s at the database: an admin, a member, a viewer and the system do not turn writing on, an owner does, and an admin may switch it off', async () => {
    const org = await makeOrg();
    await owner(`INSERT INTO crove_ads.ad_org_setting (org_id) VALUES ($1)`, [org.orgId]);
    const on = `UPDATE crove_ads.ad_org_setting SET write_enabled = true WHERE org_id = $1`;
    for (const who of ['admin', 'member', 'viewer', 'system'] as const) await inContext(org, who, (c) => refused(c, on, [org.orgId], 'ADS_SWITCH_FORBIDDEN'));
    await inContext(org, 'owner', (c) => c.query(on, [org.orgId]), true);
    // Stopping is an owner's or an admin's; a member's is refused.
    await inContext(org, 'member', (c) => refused(c, `UPDATE crove_ads.ad_org_setting SET write_enabled = false WHERE org_id = $1`, [org.orgId], 'ADS_SWITCH_FORBIDDEN'));
    await inContext(org, 'admin', (c) => c.query(`UPDATE crove_ads.ad_org_setting SET write_enabled = false, launches_blocked = true WHERE org_id = $1`, [org.orgId]), true);
    // Opening launches again after a block is the owner's (or an approved proposal's), not an admin's.
    await inContext(org, 'admin', (c) => refused(c, `UPDATE crove_ads.ad_org_setting SET launches_blocked = false WHERE org_id = $1`, [org.orgId], 'ADS_SWITCH_FORBIDDEN'));
  });

  it('judges the approval of a launch on the people of the org now, one eligible person approves their own plan, two do not', async () => {
    const org = await makeOrg();
    // The policy of the command: the roles, no approval permission, four-eyes, no ledger, and judged on the members now. (The rules' version, 4, is the one
    // every approval audit row carries: ads.db.test.ts reads it off the launch's own approval.)
    expect(await rows(`SELECT roles, permission, four_eyes, ledger FROM crove_kernel.approval_command_policy('ads.campaign.launch')`)).toEqual([{ roles: ['owner', 'admin'], permission: null, four_eyes: true, ledger: false }]);
    expect((await rows<{ live: boolean }>(`SELECT crove_kernel.approval_command_live('ads.campaign.launch') AS live`))[0]?.live).toBe(true);
    expect(liveApprovalCommands()).toContain('ads.campaign.launch');
    const author = [{ type: 'user', id: org.owner }];
    const decide = async (user: string, snapshot: string[]) =>
      (await rows<{ d: { reason: string; eligibleCount: number; selfApproved: boolean; version: number } }>(`SELECT crove_kernel.proposal_approval_decide($1::uuid, 'ads.campaign.launch', 'pending', $2::uuid[], $3::jsonb, $4::uuid, false) AS d`, [org.orgId, snapshot, JSON.stringify(author), user]))[0]?.d;
    // Answered for the org of the caller's own context only (another org answers nothing), so it is asked from the owner's.
    const eligible = () => inContext(org, 'owner', async (c) => (await c.query<{ ids: string[] }>(`SELECT crove_kernel.approval_eligible_now($1::uuid, 'ads.campaign.launch') AS ids`, [org.orgId])).rows[0]?.ids.sort());
    // The owner and the admin are the eligible people (a member and a viewer are not); the org has both, so the owner who wrote the plan may not approve it.
    expect(await eligible()).toEqual([org.owner, org.admin].sort());
    expect(await decide(org.owner, [org.owner])).toMatchObject({ reason: 'four_eyes', eligibleCount: 2, selfApproved: false });
    expect(await decide(org.admin, [])).toMatchObject({ reason: 'ok', eligibleCount: 2, selfApproved: false });
    expect(await decide(org.member, [org.owner])).toMatchObject({ reason: 'not_eligible' });
    expect(await decide(org.viewer, [org.owner])).toMatchObject({ reason: 'not_eligible' });
    // The admin leaves: the owner is the only eligible person now, whatever the snapshot of the request said (it named both), and approves their own plan, flagged.
    await owner(`DELETE FROM crove_kernel.tenant_member WHERE org_id = $1 AND user_id = $2`, [org.orgId, org.admin]);
    expect(await eligible()).toEqual([org.owner]);
    expect(await decide(org.owner, [org.owner, org.admin])).toMatchObject({ reason: 'ok', eligibleCount: 1, selfApproved: true });
    // An admin who joins again makes two: the owner may not approve their own plan any more, though the snapshot named them alone.
    await owner(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin')`, [org.orgId, org.admin]);
    expect(await decide(org.owner, [org.owner])).toMatchObject({ reason: 'four_eyes', eligibleCount: 2 });
  });
});

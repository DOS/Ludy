// SPDX-License-Identifier: AGPL-3.0-only
// The sealed copy of a closed ads connection's token (ADR-0043 point 4, ADR-0025's amendment of 2026-11-03, issue #2296, W2-1, the Platform PO's
// conditions): Ludy keeps a copy of that one token, sealed, for at most seven days, only to remove the person's permissions at the platform. Each
// condition is a test here, against a real PostgreSQL, in SQL where the claim is about the database and not about a command:
//   1. no role has any privilege on the sealed copy, and tenant roles only read the state of the obligation;
//   2. the copy is opened by one worker-only definer, and the worker definers refuse every other session, even one that was granted EXECUTE;
//   3. whatever path drops the credential of an ads connection holds the copy first, in the same transaction, once per connection; and not for a
//      platform's own deletion, a connection that is not an ad one, a read token that holds no spend permission, or an org that is not active;
//   4. the copy ends in the statement that ends the obligation, only by a try that worked, the tenth try or the seventh day, never earlier, and a
//      settled obligation never changes again;
//   5. the org's purge wipes the copy and the state at once and holds nothing new;
//   6. a member's removal does not wipe an unrevoked copy (the definer does not look at the connector).
// The source pins (one file opens the copy, nothing else names its table) are in ads-token-seal-source.test.ts. Keep this directory self-contained:
// import code under test, not fixtures from outside it. Set CROVE_TEST_ADMIN_URL to a superuser URL; the run creates and drops its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime, type BlobStore } from '@crove/kernel-runtime';
import { orgPurgeCommand, purgeOrg } from '../../src/org-purge.ts';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const DAY = 86_400_000;
const ROLES = ['crove_app', 'crove_worker', 'crove_tenant', 'crove_definer_tenant', 'crove_auth_reader'];
const WORKER_ONLY = [
  'crove_ads.token_revoke_due(integer)',
  'crove_ads.token_seal_get(uuid,uuid)',
  'crove_ads.token_revoke_settle(uuid,uuid,text,integer,timestamp with time zone,text,text,text,text)',
  'crove_ads.token_revoke_expire()',
  'crove_ads.write_orphans(uuid,uuid,integer)',
  // The kernel's check, in the org's system context, that the connector of an active connection is gone (the system command that closes it asks it).
  'crove_kernel.channel_connector_gone(uuid)',
];
// Definers no role executes (a trigger runs them): the hold and the guard.
const NOBODY = ['crove_ads.token_hold()', 'crove_ads.ad_token_revoke_guard()'];
const PINNED = { definer: true, config: ['search_path=pg_catalog, pg_temp'], public: false };

const noBlobs: BlobStore = {
  put: async () => {
    throw new Error('not used');
  },
  get: async () => {
    throw new Error('not used');
  },
  delete: async () => {},
};

const suite = ADMIN ? describe : describe.skip;

suite('the sealed copy of a closed ads connection token (#2296, W2-1)', () => {
  const dbName = `crove_test_adsseal_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let workerUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let runtime: Runtime;
  let worker: Runtime;

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

  // An org with an owner, active.
  async function makeOrg() {
    const tag = randomUUID().slice(0, 8);
    const user = await upsertIdentity(createDb(pool), { issuer: 'test', subject: `owner-${tag}`, email: `owner-${tag}@seal.test`, name: null });
    const org = await createOrg(runtime, { type: 'user', userId: user, aal: 'aal1' }, `Công ty ${tag}`);
    return { orgId: org.orgId, userId: user };
  }

  // A connection with a credential, as a connect leaves it (the envelope is made-up bytes: nothing here opens it).
  async function connection(org: { orgId: string; userId: string }, options: { provider: string; scopes?: string[]; external?: string } = { provider: 'sandboxwrite_ads' }) {
    const id = randomUUID();
    const envelope = Buffer.from(`sealed-${randomUUID()}`);
    await admin(async (c) => {
      await c.query(
        `INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, scopes, connected_by) VALUES ($1, $2, $3, $4, 'Thử', $5, $6)`,
        [org.orgId, id, options.provider, options.external ?? `acct-${id.slice(0, 8)}`, options.scopes ?? [], org.userId],
      );
      await c.query(`INSERT INTO crove_kernel.credential (org_id, connection_id, key_id, envelope) VALUES ($1, $2, 'k1', $3)`, [org.orgId, id, envelope]);
    });
    return { id, envelope };
  }

  // Closes a connection the way the kernel's commands do: the status and its reason first, then the credential goes.
  const close = (org: { orgId: string }, id: string, reason = 'disconnected') =>
    admin(async (c) => {
      await c.query('BEGIN');
      await c.query(`UPDATE crove_kernel.channel_connection SET status = 'revoked', status_reason = $3 WHERE org_id = $1 AND id = $2`, [org.orgId, id, reason]);
      await c.query('DELETE FROM crove_kernel.credential WHERE org_id = $1 AND connection_id = $2', [org.orgId, id]);
      await c.query('COMMIT');
    });

  const obligations = (orgId: string, connectionId?: string) =>
    rows<{ id: string; kind: string; state: string; attempts: number; reason: string; provider: string; seals: string }>(
      `SELECT r.id, r.kind, r.state, r.attempts, r.reason, r.provider, (SELECT count(*)::text FROM crove_ads.ad_token_seal s WHERE s.org_id = r.org_id AND s.revoke_id = r.id) AS seals
       FROM crove_ads.ad_token_revoke r WHERE r.org_id = $1 AND ($2::uuid IS NULL OR r.connection_id = $2) ORDER BY r.created_at, r.id`,
      [orgId, connectionId ?? null],
    );

  // The guard is for every role, so the test changes the rows as the table owner, each statement in a transaction of its own (a refusal aborts it).
  const owner = (text: string, params: unknown[] = []) => admin(async (c) => (await c.query(text, params)).rowCount);

  // A held obligation of a fresh org, with its copy: the starting point of most tests.
  async function held(options: { provider?: string; scopes?: string[] } = {}) {
    const org = await makeOrg();
    const conn = await connection(org, { provider: options.provider ?? 'sandboxwrite_ads', ...(options.scopes ? { scopes: options.scopes } : {}) });
    await close(org, conn.id);
    const [row] = await obligations(org.orgId, conn.id);
    if (!row) throw new Error('no obligation was made');
    return { org, conn, revoke: row.id };
  }

  const workerSql = <T extends pg.QueryResultRow>(text: string, params: unknown[] = []) => withClient(workerUrl, async (c) => (await c.query<T>(text, params)).rows);

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
    workerPool = createPool({ connectionString: workerUrl, max: 2 });
    const registry = { commands: kernelCommands, queries: kernelQueries({ inboundDomain: null }) };
    runtime = new Runtime(createDb(pool), { manifests: TEST_MANIFESTS }).register(registry);
    worker = new Runtime(createDb(workerPool), { manifests: TEST_MANIFESTS }).register(registry).register({ commands: [orgPurgeCommand({ store: noBlobs })] });
  }, 300_000);

  afterAll(async () => {
    await pool?.end();
    await workerPool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('gives no role any privilege on the sealed copy, and tenant roles only read the state of the obligation', async () => {
    const seal = await rows<{ role: string; priv: string }>(
      `SELECT r AS role, p AS priv FROM unnest($1::text[]) r, unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p
       WHERE has_table_privilege(r, 'crove_ads.ad_token_seal', p) OR (p IN ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES') AND has_any_column_privilege(r, 'crove_ads.ad_token_seal', p))`,
      [ROLES],
    );
    expect(seal).toEqual([]);
    // PUBLIC too: the table's own ACL has no entry for it.
    const acl = await rows<{ public: boolean; grantees: string[] }>(
      `SELECT EXISTS (SELECT 1 FROM aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) x WHERE x.grantee = 0) AS public,
              ARRAY(SELECT DISTINCT x.grantee::regrole::text FROM aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) x WHERE x.grantee <> c.relowner) AS grantees
       FROM pg_class c WHERE c.oid = 'crove_ads.ad_token_seal'::regclass`,
    );
    expect(acl).toEqual([{ public: false, grantees: [] }]);
    // Row level security stays on, so a grant added later stays deny-all until a policy is written.
    expect((await rows<{ on: boolean }>(`SELECT relrowsecurity AS on FROM pg_class WHERE oid = 'crove_ads.ad_token_seal'::regclass`))[0]?.on).toBe(true);
    // The state: members read it (the screen), and no role but the definers writes it.
    const state = await rows<{ role: string; priv: string }>(
      `SELECT r AS role, p AS priv FROM unnest($1::text[]) r, unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) p
       WHERE has_table_privilege(r, 'crove_ads.ad_token_revoke', p) OR (p IN ('INSERT', 'UPDATE') AND has_any_column_privilege(r, 'crove_ads.ad_token_revoke', p)) ORDER BY 1, 2`,
      [ROLES],
    );
    expect(state).toEqual([{ role: 'crove_tenant', priv: 'SELECT' }]);
  });

  it('opens the copy through one worker-only definer, and the worker definers refuse every other session, even one granted EXECUTE', async () => {
    const { matrix, shape } = await withClient(adminUrl, async (c) => {
      const { rows: granted } = await c.query<{ fn: string; role: string }>(
        `SELECT f AS fn, r AS role FROM unnest($1::text[]) f, unnest($2::text[]) r WHERE has_function_privilege(r, f::regprocedure, 'EXECUTE') ORDER BY 1, 2`,
        [[...WORKER_ONLY, ...NOBODY], ROLES],
      );
      const { rows: defs } = await c.query<{ definer: boolean; config: string[]; public: boolean }>(
        `SELECT p.prosecdef AS definer, p.proconfig AS config, EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x WHERE x.grantee = 0) AS public
         FROM unnest($1::text[]) f JOIN pg_proc p ON p.oid = f::regprocedure`,
        [[...WORKER_ONLY, ...NOBODY]],
      );
      return { matrix: granted, shape: defs };
    });
    expect(matrix.map((r) => `${r.fn} ${r.role}`).sort()).toEqual(WORKER_ONLY.map((fn) => `${fn} crove_worker`).sort());
    expect(shape).toEqual([...WORKER_ONLY, ...NOBODY].map(() => PINNED));

    const { org, revoke } = await held();
    // The API login: no EXECUTE, so it cannot open a copy or move an obligation.
    await expect(withClient(appUrl, (c) => c.query('SELECT * FROM crove_ads.token_seal_get($1::uuid, $2::uuid)', [org.orgId, revoke]))).rejects.toThrow(/permission denied for function token_seal_get/);
    await expect(withClient(appUrl, (c) => c.query('SELECT crove_ads.token_revoke_expire()'))).rejects.toThrow(/permission denied for function token_revoke_expire/);
    // A mistaken grant does not open it either: the definer asks whose session it is.
    await admin(async (c) => c.query('GRANT EXECUTE ON FUNCTION crove_ads.token_seal_get(uuid, uuid) TO crove_app'));
    try {
      await expect(withClient(appUrl, (c) => c.query('SELECT * FROM crove_ads.token_seal_get($1::uuid, $2::uuid)', [org.orgId, revoke]))).rejects.toMatchObject({ code: '42501', message: 'ADS_WORKER_ONLY' });
    } finally {
      await admin(async (c) => c.query('REVOKE EXECUTE ON FUNCTION crove_ads.token_seal_get(uuid, uuid) FROM crove_app'));
    }
    // The worker login opens exactly the copy that was held, and only while the obligation is pending.
    const opened = await workerSql<{ key_id: string; envelope: Buffer; provider: string }>('SELECT key_id, envelope, provider FROM crove_ads.token_seal_get($1::uuid, $2::uuid)', [org.orgId, revoke]);
    expect(opened).toHaveLength(1);
    expect(opened[0]?.key_id).toBe('k1');
    expect(opened[0]?.provider).toBe('sandboxwrite_ads');
    // Not another org's: the same obligation id under another org finds nothing.
    await expect(workerSql('SELECT * FROM crove_ads.token_seal_get($1::uuid, $2::uuid)', [(await makeOrg()).orgId, revoke])).rejects.toMatchObject({ message: 'ADS_SEAL_GONE' });
  });

  it('holds the copy when the credential of an ads connection is dropped, by whatever path, once, and ends nothing else', async () => {
    const org = await makeOrg();
    const write = await connection(org, { provider: 'sandboxwrite_ads' });
    await close(org, write.id, 'disconnected');
    expect(await obligations(org.orgId, write.id)).toEqual([expect.objectContaining({ kind: 'write', state: 'pending', attempts: 0, reason: 'disconnected', provider: 'sandboxwrite_ads', seals: '1' })]);
    // The held copy is the very envelope the credential table held.
    const [revoke] = await obligations(org.orgId, write.id);
    const copy = await rows<{ envelope: Buffer; key_id: string }>('SELECT envelope, key_id FROM crove_ads.ad_token_seal WHERE org_id = $1 AND revoke_id = $2', [org.orgId, revoke?.id]);
    expect(copy[0]?.envelope.equals(write.envelope)).toBe(true);
    expect(copy[0]?.key_id).toBe('k1');
    // The credential is gone as before, and a second drop of the same connection changes nothing (one obligation per connection).
    expect(await rows('SELECT 1 FROM crove_kernel.credential WHERE org_id = $1 AND connection_id = $2', [org.orgId, write.id])).toEqual([]);
    await owner('INSERT INTO crove_kernel.credential (org_id, connection_id, key_id, envelope) VALUES ($1, $2, $3, $4)', [org.orgId, write.id, 'k2', Buffer.from('again')]);
    await owner('DELETE FROM crove_kernel.credential WHERE org_id = $1 AND connection_id = $2', [org.orgId, write.id]);
    expect(await obligations(org.orgId, write.id)).toHaveLength(1);
    expect((await obligations(org.orgId, write.id))[0]?.seals).toBe('1');

    // The reasons a connection closes with are kept as codes; a sentence is kept as "other".
    for (const [reason, kept] of [['spend_scopes', 'spend_scopes'], ['member_left', 'member_left'], ['Token expired for a long reason', 'other']] as const) {
      const c = await connection(org, { provider: 'metawrite_ads' });
      await close(org, c.id, reason);
      expect((await obligations(org.orgId, c.id))[0]).toMatchObject({ kind: 'write', reason: kept, provider: 'metawrite_ads', seals: '1' });
    }

    // A read connection whose recorded scopes hold a spend permission holds a token that can change campaigns: held, as the read kind.
    for (const scope of ['ads_management', 'business_management']) {
      const read = await connection(org, { provider: 'meta_ads', scopes: ['ads_read', scope] });
      await close(org, read.id);
      expect((await obligations(org.orgId, read.id))[0]).toMatchObject({ kind: 'read_spend', provider: 'meta_ads', seals: '1' });
    }

    // Not held: a read token with no spend permission (the fail-safe close of a reading connection is local), a provider that is not an ad one,
    // a platform's own data deletion (the person already removed the app), and an org that is not active (the purge wipes).
    const read = await connection(org, { provider: 'meta_ads', scopes: ['ads_read'] });
    await close(org, read.id, 'spend_scopes');
    const social = await connection(org, { provider: 'facebook_page', scopes: ['ads_management'] });
    await close(org, social.id);
    const deleted = await connection(org, { provider: 'metawrite_ads' });
    await close(org, deleted.id, 'platform_deletion');
    for (const none of [read.id, social.id, deleted.id]) expect(await obligations(org.orgId, none), none).toEqual([]);
    const closing = await makeOrg();
    const inactive = await connection(closing, { provider: 'metawrite_ads' });
    await admin(async (c) => {
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query(`UPDATE crove_kernel.tenant SET status = 'offboarding' WHERE org_id = $1`, [closing.orgId]);
      await c.query('COMMIT');
    });
    await close(closing, inactive.id);
    expect(await obligations(closing.orgId)).toEqual([]);
    expect(await rows('SELECT 1 FROM crove_kernel.credential WHERE org_id = $1', [closing.orgId])).toEqual([]);
  });

  it('keeps an obligation to what it was born as: pending, with no tries, and never another connection, kind or reason', async () => {
    const org = await makeOrg();
    const conn = await connection(org);
    const insert = (extra: string, value: string) =>
      owner(
        `INSERT INTO crove_ads.ad_token_revoke (org_id, connection_id, provider, external_account_id, kind, reason, ${extra}) VALUES ($1, $2, 'sandboxwrite_ads', 'x', 'write', 'switch_off', ${value})`,
        [org.orgId, conn.id],
      );
    await expect(insert('attempts', '3')).rejects.toMatchObject({ code: '42501', message: 'ADS_REVOKE_FORBIDDEN' });
    await expect(insert('settled_at', 'now()')).rejects.toMatchObject({ code: '42501' });
    await close(org, conn.id);
    const [row] = await obligations(org.orgId, conn.id);
    for (const [column, value] of [['kind', `'read_spend'`], ['reason', `'other'`], ['provider', `'meta_ads'`], ['external_account_id', `'y'`], ['created_at', `now() + interval '1 day'`]]) {
      await expect(owner(`UPDATE crove_ads.ad_token_revoke SET ${column} = ${value} WHERE org_id = $1 AND id = $2`, [org.orgId, row?.id]), column).rejects.toMatchObject({ code: '42501', message: 'ADS_REVOKE_FORBIDDEN' });
    }
  });

  it('ends the copy only by a try that worked, the tenth try or the seventh day, and the end is final', async () => {
    const { org, revoke } = await held();
    const update = (set: string) => owner(`UPDATE crove_ads.ad_token_revoke SET ${set} WHERE org_id = $1 AND id = $2`, [org.orgId, revoke]);
    const copies = async () => Number((await obligations(org.orgId))[0]?.seals);
    // Nothing ends it without the try: done with no try, a give-up by attempts with fewer than ten, a give-up by age before the seventh day.
    await expect(update(`state = 'done', how_done = 'revoked', next_attempt_at = NULL`)).rejects.toMatchObject({ code: '42501', message: 'ADS_REVOKE_FORBIDDEN' });
    await expect(update(`state = 'gave_up', give_up = 'attempts', next_attempt_at = NULL, attempts = attempts + 1`)).rejects.toMatchObject({ code: '42501' });
    await expect(update(`state = 'gave_up', give_up = 'age', next_attempt_at = NULL`)).rejects.toMatchObject({ code: '42501' });
    // A try is counted once, never taken back and never skipped.
    await expect(update('attempts = attempts + 2')).rejects.toMatchObject({ code: '42501' });
    expect(await copies()).toBe(1);
    // Nine tries that failed keep the copy; the tenth ends it.
    for (let i = 1; i <= 8; i++) await update(`attempts = ${i}, last_error_kind = 'transient', next_attempt_at = now()`);
    await expect(update(`state = 'gave_up', give_up = 'attempts', next_attempt_at = NULL, attempts = 9`)).rejects.toMatchObject({ code: '42501' });
    await update(`attempts = 9, next_attempt_at = now()`);
    expect(await copies()).toBe(1);
    await update(`state = 'gave_up', give_up = 'attempts', next_attempt_at = NULL, attempts = 10`);
    expect((await obligations(org.orgId))[0]).toMatchObject({ state: 'gave_up', attempts: 10, seals: '0' });
    // Final: nothing changes a settled obligation, not even to the same state.
    await expect(update(`state = 'done', how_done = 'revoked', next_attempt_at = NULL, attempts = 10`)).rejects.toMatchObject({ code: '42501', message: 'ADS_REVOKE_FORBIDDEN' });
    await expect(update(`last_error_code = 'LATE'`)).rejects.toMatchObject({ code: '42501' });
  });

  it('ends the copy when the revoke worked, in the same statement, with the time it took', async () => {
    const { org, revoke } = await held();
    await owner(`UPDATE crove_ads.ad_token_revoke SET state = 'done', how_done = 'revoked', next_attempt_at = NULL, attempts = 1 WHERE org_id = $1 AND id = $2`, [org.orgId, revoke]);
    const [row] = await rows<{ state: string; how_done: string; settled: boolean; seals: string }>(
      `SELECT r.state, r.how_done, r.settled_at IS NOT NULL AS settled, (SELECT count(*)::text FROM crove_ads.ad_token_seal s WHERE s.org_id = r.org_id) AS seals FROM crove_ads.ad_token_revoke r WHERE r.org_id = $1 AND r.id = $2`,
      [org.orgId, revoke],
    );
    expect(row).toEqual({ state: 'done', how_done: 'revoked', settled: true, seals: '0' });
    // A copy that is gone is gone for the worker too.
    await expect(workerSql('SELECT * FROM crove_ads.token_seal_get($1::uuid, $2::uuid)', [org.orgId, revoke])).rejects.toMatchObject({ message: 'ADS_SEAL_GONE' });
  });

  it('settles an obligation past its seventh day without a try and wipes its copy, and keeps one that is younger', async () => {
    const old = await held();
    const young = await held();
    // The only way to make an obligation old is to change its birth: the guard is switched off for that one statement, as the owner of the table.
    await admin(async (c) => {
      await c.query('ALTER TABLE crove_ads.ad_token_revoke DISABLE TRIGGER ad_token_revoke_guard');
      try {
        await c.query(`UPDATE crove_ads.ad_token_revoke SET created_at = now() - interval '8 days' WHERE org_id = $1 AND id = $2`, [old.org.orgId, old.revoke]);
        await c.query(`UPDATE crove_ads.ad_token_revoke SET created_at = now() - interval '6 days 23 hours' WHERE org_id = $1 AND id = $2`, [young.org.orgId, young.revoke]);
      } finally {
        await c.query('ALTER TABLE crove_ads.ad_token_revoke ENABLE ALWAYS TRIGGER ad_token_revoke_guard');
      }
    });
    const swept = await workerSql<{ n: number }>('SELECT crove_ads.token_revoke_expire() AS n');
    expect(swept[0]?.n).toBeGreaterThanOrEqual(1);
    expect((await rows<{ state: string; give_up: string; attempts: number; next: Date | null; seals: string }>(
      `SELECT r.state, r.give_up, r.attempts, r.next_attempt_at AS next, (SELECT count(*)::text FROM crove_ads.ad_token_seal s WHERE s.org_id = r.org_id) AS seals FROM crove_ads.ad_token_revoke r WHERE r.org_id = $1 AND r.id = $2`,
      [old.org.orgId, old.revoke],
    ))[0]).toEqual({ state: 'gave_up', give_up: 'age', attempts: 0, next: null, seals: '0' });
    expect((await obligations(young.org.orgId))[0]).toMatchObject({ state: 'pending', seals: '1' });
  });

  it('claims a due obligation once: a second claim within the lease finds it taken', async () => {
    const { org, revoke } = await held();
    const claim = async () => (await workerSql<{ org_id: string; id: string }>('SELECT org_id, id FROM crove_ads.token_revoke_due(100)')).filter((r) => r.id === revoke);
    expect(await claim()).toHaveLength(1);
    expect(await claim()).toHaveLength(0);
    // The lease is ten minutes; the count did not move, since a claim is not a try.
    const [row] = await rows<{ minutes: number; attempts: number }>(
      `SELECT extract(epoch FROM (next_attempt_at - now())) / 60 AS minutes, attempts FROM crove_ads.ad_token_revoke WHERE org_id = $1 AND id = $2`,
      [org.orgId, revoke],
    );
    expect(Number(row?.minutes)).toBeGreaterThan(8);
    expect(Number(row?.minutes)).toBeLessThanOrEqual(10);
    expect(row?.attempts).toBe(0);
  });

  it('does not wipe a copy when the member who connected the connection leaves: the copy opens as before, and only the revoke ends it', async () => {
    const org = await makeOrg();
    // A second member connects the connection, the owner closes it, and the second member is removed from the org.
    const member = await upsertIdentity(createDb(pool), { issuer: 'test', subject: `admin-${randomUUID().slice(0, 8)}`, email: `admin-${randomUUID().slice(0, 8)}@seal.test`, name: null });
    await owner(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin')`, [org.orgId, member]);
    const conn = await connection({ orgId: org.orgId, userId: member }, { provider: 'sandboxwrite_ads' });
    await close(org, conn.id);
    const [row] = await obligations(org.orgId, conn.id);
    await owner('DELETE FROM crove_kernel.tenant_member WHERE org_id = $1 AND user_id = $2', [org.orgId, member]);
    expect((await obligations(org.orgId, conn.id))[0]).toMatchObject({ state: 'pending', seals: '1' });
    const opened = await workerSql<{ envelope: Buffer }>('SELECT envelope FROM crove_ads.token_seal_get($1::uuid, $2::uuid)', [org.orgId, row?.id]);
    expect(opened[0]?.envelope.equals(conn.envelope)).toBe(true);
    // The kernel's own door for the credential of an open connection does ask who connected it; this one does not, and only the worker has it.
    await owner(`UPDATE crove_ads.ad_token_revoke SET state = 'done', how_done = 'revoked', next_attempt_at = NULL, attempts = 1 WHERE org_id = $1 AND id = $2`, [org.orgId, row?.id]);
    expect((await obligations(org.orgId, conn.id))[0]).toMatchObject({ state: 'done', seals: '0' });
  });

  it('lists the write connections of people who left, and only those, for the sweep to close', async () => {
    const org = await makeOrg();
    const left = await upsertIdentity(createDb(pool), { issuer: 'test', subject: `left-${randomUUID().slice(0, 8)}`, email: `left-${randomUUID().slice(0, 8)}@seal.test`, name: null });
    const demoted = await upsertIdentity(createDb(pool), { issuer: 'test', subject: `demoted-${randomUUID().slice(0, 8)}`, email: `demoted-${randomUUID().slice(0, 8)}@seal.test`, name: null });
    const disabled = await upsertIdentity(createDb(pool), { issuer: 'test', subject: `disabled-${randomUUID().slice(0, 8)}`, email: `disabled-${randomUUID().slice(0, 8)}@seal.test`, name: null });
    await owner(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'admin'), ($1, $4, 'admin')`, [org.orgId, left, demoted, disabled]);
    const mine = await connection(org, { provider: 'sandboxwrite_ads' });
    const goneConn = await connection({ orgId: org.orgId, userId: left }, { provider: 'sandboxwrite_ads' });
    const demotedConn = await connection({ orgId: org.orgId, userId: demoted }, { provider: 'metawrite_ads' });
    const disabledConn = await connection({ orgId: org.orgId, userId: disabled }, { provider: 'sandboxwrite_ads' });
    // Not an ad connection: never listed, whoever connected it.
    const other = await connection({ orgId: org.orgId, userId: left }, { provider: 'facebook_page' });
    await owner('DELETE FROM crove_kernel.tenant_member WHERE org_id = $1 AND user_id = $2', [org.orgId, left]);
    await owner(`UPDATE crove_kernel.tenant_member SET role = 'viewer' WHERE org_id = $1 AND user_id = $2`, [org.orgId, demoted]);
    await owner('UPDATE crove_kernel.user_account SET disabled_at = now() WHERE id = $1', [disabled]);
    const listed = (await workerSql<{ org_id: string; connection_id: string }>('SELECT org_id, connection_id FROM crove_ads.write_orphans(NULL, NULL, 500)')).filter((r) => r.org_id === org.orgId).map((r) => r.connection_id).sort();
    expect(listed).toEqual([goneConn.id, demotedConn.id, disabledConn.id].sort());
    expect(listed).not.toContain(mine.id);
    expect(listed).not.toContain(other.id);
    // After a key, in key order, with the page size honoured.
    const first = await workerSql<{ org_id: string; connection_id: string }>('SELECT org_id, connection_id FROM crove_ads.write_orphans(NULL, NULL, 1)');
    expect(first).toHaveLength(1);
    const next = await workerSql<{ org_id: string; connection_id: string }>('SELECT org_id, connection_id FROM crove_ads.write_orphans($1::uuid, $2::uuid, 500)', [first[0]?.org_id, first[0]?.connection_id]);
    expect(next.some((r) => r.connection_id === first[0]?.connection_id)).toBe(false);
  });

  it('wipes the copy and the state at once when the org is purged, and the purge holds nothing new', async () => {
    const org = await makeOrg();
    const write = await connection(org, { provider: 'metawrite_ads' });
    await close(org, write.id);
    // A connection that is still open when the purge runs: the purge drops its credential, which must not make a new copy.
    const open = await connection(org, { provider: 'metawrite_ads' });
    expect((await obligations(org.orgId)).map((o) => o.seals)).toEqual(['1']);
    await admin(async (c) => {
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query(`UPDATE crove_kernel.tenant SET status = 'offboarding' WHERE org_id = $1`, [org.orgId]);
      await c.query('COMMIT');
      for (const [command, actorType, actorId, daysAgo, detail] of [
        ['kernel.org.offboard', 'user', org.userId, 36, {}],
        ['kernel.org.export.record', 'system', null, 31, { format: 'crove.org-export.v2' }],
      ] as const) {
        await c.query(
          `INSERT INTO crove_kernel.audit_event (org_id, occurred_at, actor_type, actor_id, command, command_id, outcome, input_sha256, detail) VALUES ($1, $2, $3, $4, $5, $6, 'ok', $7, $8)`,
          [org.orgId, new Date(Date.now() - daysAgo * DAY), actorType, actorId, command, randomUUID(), '0'.repeat(64), JSON.stringify(detail)],
        );
      }
    });
    await expect(purgeOrg(worker, 30, { ref: org.orgId, reason: 'test' })).resolves.toMatchObject({ kind: 'purged', orgId: org.orgId });
    expect(await obligations(org.orgId)).toEqual([]);
    expect(await rows('SELECT 1 FROM crove_ads.ad_token_seal WHERE org_id = $1', [org.orgId])).toEqual([]);
    expect(await rows('SELECT 1 FROM crove_kernel.credential WHERE org_id = $1 AND connection_id = $2', [org.orgId, open.id])).toEqual([]);
    // The purge's map names both tables, the copy before the state it references and both before the ad accounts.
    const body = (await rows<{ def: string }>(`SELECT pg_get_functiondef('crove_kernel.org_purge(integer)'::regprocedure) AS def`))[0]?.def ?? '';
    const seal = body.indexOf("'crove_ads.ad_token_seal'");
    const state = body.indexOf("'crove_ads.ad_token_revoke'");
    const account = body.indexOf("'crove_ads.ad_account'");
    expect(seal).toBeGreaterThan(-1);
    expect(state).toBeGreaterThan(seal);
    expect(account).toBeGreaterThan(state);
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
// The sealed copy of a closed ads connection's token (ADR-0043 point 4, ADR-0025's amendment of 2026-11-03, issue #2296, W2-1, the Platform PO's
// conditions): Ludy keeps a copy of that one token, sealed, for at most seven days, only to remove the person's permissions at the platform, for Meta's
// ads providers and the offline sandbox. Each condition is a test here, against a real PostgreSQL, in SQL where the claim is about the database and not
// about a command:
//   1. no role has any privilege on the sealed copy, and tenant roles only read the state of the obligation (and never delete it);
//   2. the copy is opened by one worker-only definer, in the org's system context, for a claimed obligation, and counts the try as it opens; the worker
//      definers refuse every other session, even one that was granted EXECUTE; it refuses a copy that is not pending, is seven days old or has used its
//      ten tries, and serves the copy of a connection whose member has left;
//   3. whatever path drops the credential of an ads connection holds the copy first, in the same statement, once per connection, for the providers the owner
//      approved only; and not for a platform's own deletion, a read token that holds no spend permission, or an org that is not active;
//   4. the copy ends in the statement that ends the obligation, only by a try that worked, the tenth try, the seventh day or the finding that nothing can
//      be revoked, and a settled obligation never changes again;
//   5. a reconnect of the account cancels the pending revoke and wipes its copy in the same transaction (a reseal does not);
//   6. whether another live connection of the same grantor needs the grant is a boolean, and nothing else of another org leaves the database;
//   7. the age limit holds with no job running: a copy older than seven days is wiped by the sweep alone;
//   8. the org's purge wipes the copy and the state at once and holds nothing new, and a close racing the purge leaves no copy either way.
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
  'crove_ads.token_grant_shared(uuid,uuid)',
  'crove_ads.token_seal_get(uuid,uuid,uuid)',
  'crove_ads.token_revoke_settle(uuid,uuid,uuid,text,timestamp with time zone,text,text,text,text)',
  'crove_ads.token_revoke_expire()',
  'crove_ads.write_orphans(uuid,uuid,integer)',
  // The kernel's check, in the org's system context, that the connector of an active connection is gone (the system command that closes it asks it).
  'crove_kernel.channel_connector_gone(uuid)',
];
// Definers no role executes (a trigger runs them): the hold, its two triggers, the reconnect and the guard.
const NOBODY = [
  'crove_ads.token_hold()',
  'crove_ads.token_hold_connection()',
  'crove_ads.token_hold_row(uuid,uuid,text,bytea,text,text,text[],text,uuid)',
  'crove_ads.token_reconnected()',
  'crove_ads.ad_token_revoke_guard()',
];
const PINNED = { definer: true, config: ['search_path=pg_catalog, pg_temp'], public: false };
const HASH = 'a'.repeat(64);

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

  // An ad account read by a connection, with the keyed hash of the person who granted it (the revoke is per person and app).
  async function account(org: { orgId: string }, connectionId: string, provider: string, external: string, hash: string | null) {
    const id = randomUUID();
    await admin((c) =>
      c.query(`INSERT INTO crove_ads.ad_account (org_id, id, channel_connection_id, provider, external_account_id, name, backfill_from, granted_by_hash) VALUES ($1, $2, $3, $4, $5, 'Thử', '2025-10-01', $6)`, [
        org.orgId,
        id,
        connectionId,
        provider,
        external,
        hash,
      ]),
    );
    return id;
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
    rows<{ id: string; kind: string; state: string; attempts: number; reason: string; provider: string; how_done: string | null; give_up: string | null; grantor_hash: string | null; seals: string }>(
      `SELECT r.id, r.kind, r.state, r.attempts, r.reason, r.provider, r.how_done, r.give_up, r.grantor_hash,
              (SELECT count(*)::text FROM crove_ads.ad_token_seal s WHERE s.org_id = r.org_id AND s.revoke_id = r.id) AS seals
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
  // What the worker does to open a copy: claim the obligation (the claim answers the fencing token), enter the org's system context, ask the definer with
  // the token. `claim` false asks without a claim; `token` replaces the claim's token. Answers the copy and the token.
  async function openAsWorker(orgId: string, revoke: string, options: { claim?: boolean; context?: string | null; token?: string | null } = {}) {
    return withClient(workerUrl, async (c) => {
      let token: string | null = null;
      if (options.claim !== false) {
        const { rows: claimed } = await c.query<{ id: string; lease_token: string }>('SELECT id, lease_token FROM crove_ads.token_revoke_due(100)');
        token = claimed.find((r) => r.id === revoke)?.lease_token ?? null;
      }
      if (options.token !== undefined) token = options.token;
      await c.query('BEGIN');
      try {
        if (options.context !== null) await c.query('SELECT crove_kernel.enter_system_context($1::uuid)', [options.context ?? orgId]);
        const { rows: opened } = await c.query<{ key_id: string; envelope: Buffer; provider: string; external_account_id: string }>('SELECT * FROM crove_ads.token_seal_get($1::uuid, $2::uuid, $3::uuid)', [orgId, revoke, token]);
        await c.query('COMMIT');
        return Object.assign(opened, { token });
      } catch (error) {
        await c.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
    });
  }
  // Makes an obligation due and unleased at once, whatever the policy's waits.
  const dueNow = async (revoke: string) => {
    await owner(`UPDATE crove_ads.ad_token_revoke SET next_attempt_at = now() WHERE id = $1`, [revoke]);
    await owner(`UPDATE crove_ads.ad_token_seal SET lease_until = NULL, lease_token = NULL WHERE revoke_id = $1`, [revoke]);
  };

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
    // The state: members read it (the screen), and no role but the definers writes it; no login role ever deletes a row of it.
    const state = await rows<{ role: string; priv: string }>(
      `SELECT r AS role, p AS priv FROM unnest($1::text[]) r, unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) p
       WHERE has_table_privilege(r, 'crove_ads.ad_token_revoke', p) OR (p IN ('INSERT', 'UPDATE') AND has_any_column_privilege(r, 'crove_ads.ad_token_revoke', p)) ORDER BY 1, 2`,
      [ROLES],
    );
    // Reading is the tenant role's, and every role that inherits it (the API login, the definer's role); nobody holds any write privilege.
    expect(state.filter((r) => r.priv !== 'SELECT')).toEqual([]);
    expect(state.map((r) => r.role)).toContain('crove_tenant');
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
    await expect(withClient(appUrl, (c) => c.query('SELECT * FROM crove_ads.token_seal_get($1::uuid, $2::uuid, $3::uuid)', [org.orgId, revoke, randomUUID()]))).rejects.toThrow(/permission denied for function token_seal_get/);
    await expect(withClient(appUrl, (c) => c.query('SELECT crove_ads.token_revoke_expire()'))).rejects.toThrow(/permission denied for function token_revoke_expire/);
    await expect(withClient(appUrl, (c) => c.query('SELECT crove_ads.token_grant_shared($1::uuid, $2::uuid)', [org.orgId, revoke]))).rejects.toThrow(/permission denied for function token_grant_shared/);
    // A mistaken grant does not open it either: the definer asks whose session it is.
    await admin(async (c) => c.query('GRANT EXECUTE ON FUNCTION crove_ads.token_seal_get(uuid, uuid, uuid), crove_ads.token_grant_shared(uuid, uuid) TO crove_app'));
    try {
      await expect(withClient(appUrl, (c) => c.query('SELECT * FROM crove_ads.token_seal_get($1::uuid, $2::uuid, $3::uuid)', [org.orgId, revoke, randomUUID()]))).rejects.toMatchObject({ code: '42501', message: 'ADS_WORKER_ONLY' });
      await expect(withClient(appUrl, (c) => c.query('SELECT crove_ads.token_grant_shared($1::uuid, $2::uuid)', [org.orgId, revoke]))).rejects.toMatchObject({ code: '42501', message: 'ADS_WORKER_ONLY' });
    } finally {
      await admin(async (c) => c.query('REVOKE EXECUTE ON FUNCTION crove_ads.token_seal_get(uuid, uuid, uuid), crove_ads.token_grant_shared(uuid, uuid) FROM crove_app'));
    }
    // The worker login still needs the org's system context, and the obligation claimed: the worker has no way to open a copy by asking for an id.
    await expect(openAsWorker(org.orgId, revoke, { context: null })).rejects.toMatchObject({ code: '42501', message: 'NO_CONTEXT' });
    await expect(openAsWorker(org.orgId, revoke, { context: (await makeOrg()).orgId })).rejects.toMatchObject({ code: '42501', message: 'NO_CONTEXT' });
    await dueNow(revoke);
    await expect(openAsWorker(org.orgId, revoke, { claim: false })).rejects.toMatchObject({ message: 'ADS_SEAL_NOT_CLAIMED' });
    // Claimed, it opens exactly the copy that was held, with the binding stored on the obligation, and counts the try as it opens.
    const opened = await openAsWorker(org.orgId, revoke);
    expect(opened).toHaveLength(1);
    expect(opened[0]?.key_id).toBe('k1');
    expect(opened[0]?.provider).toBe('sandboxwrite_ads');
    expect((await obligations(org.orgId))[0]).toMatchObject({ state: 'pending', attempts: 1, seals: '1' });
    // The claim is consumed: a second job with the same claim finds it not claimed, so two jobs never open one copy.
    await expect(openAsWorker(org.orgId, revoke, { claim: false, token: opened.token })).rejects.toMatchObject({ message: 'ADS_SEAL_NOT_CLAIMED' });
    // Another token than the claim's is refused too.
    await dueNow(revoke);
    await openAsWorker(org.orgId, revoke, { claim: true, token: randomUUID() }).then(
      () => {
        throw new Error('opened with a token that is not the claim');
      },
      (error: { message?: string }) => expect(error.message).toBe('ADS_SEAL_NOT_CLAIMED'),
    );
    // Not another org's: the same obligation id under another org finds nothing.
    const other = await makeOrg();
    await expect(openAsWorker(other.orgId, revoke)).rejects.toMatchObject({ message: 'ADS_SEAL_GONE' });
  });

  it('refuses to open a copy that is seven days old, by the obligation or by the copy, or has used its ten tries, even before a sweep wipes it', async () => {
    const tenth = await held();
    for (let i = 1; i <= 9; i++) await owner(`UPDATE crove_ads.ad_token_revoke SET attempts = ${i}, next_attempt_at = now() WHERE id = $1`, [tenth.revoke]);
    await openAsWorker(tenth.org.orgId, tenth.revoke);
    expect((await obligations(tenth.org.orgId))[0]?.attempts).toBe(10);
    // Ten tries used: the next claim does not take it (the sweep finishes it), and an open is refused.
    await owner(`UPDATE crove_ads.ad_token_revoke SET next_attempt_at = now() WHERE id = $1`, [tenth.revoke]);
    await owner(`UPDATE crove_ads.ad_token_seal SET lease_until = now() + interval '5 minutes', lease_token = $2 WHERE revoke_id = $1`, [tenth.revoke, randomUUID()]);
    await expect(openAsWorker(tenth.org.orgId, tenth.revoke, { claim: false, token: null })).rejects.toMatchObject({ message: 'ADS_SEAL_GONE' });

    // Old by the copy alone: the seal's own date, with the obligation young.
    const oldCopy = await held();
    await owner(`UPDATE crove_ads.ad_token_seal SET sealed_at = now() - interval '8 days' WHERE org_id = $1 AND revoke_id = $2`, [oldCopy.org.orgId, oldCopy.revoke]);
    await dueNow(oldCopy.revoke);
    await expect(openAsWorker(oldCopy.org.orgId, oldCopy.revoke)).rejects.toMatchObject({ message: 'ADS_SEAL_GONE' });
    expect((await obligations(oldCopy.org.orgId))[0]).toMatchObject({ state: 'pending', attempts: 0, seals: '1' });

    // Old by the obligation alone (the guard is switched off for the one statement that changes a birth, as the owner of the table).
    const oldRow = await held();
    await admin(async (c) => {
      await c.query('ALTER TABLE crove_ads.ad_token_revoke DISABLE TRIGGER ad_token_revoke_guard');
      try {
        await c.query(`UPDATE crove_ads.ad_token_revoke SET created_at = now() - interval '8 days', next_attempt_at = now() WHERE id = $1`, [oldRow.revoke]);
      } finally {
        await c.query('ALTER TABLE crove_ads.ad_token_revoke ENABLE ALWAYS TRIGGER ad_token_revoke_guard');
      }
    });
    await expect(openAsWorker(oldRow.org.orgId, oldRow.revoke)).rejects.toMatchObject({ message: 'ADS_SEAL_GONE' });
    // A settled one is refused too.
    const done = await held();
    await owner(`UPDATE crove_ads.ad_token_revoke SET state = 'done', how_done = 'shared_grant', next_attempt_at = NULL WHERE id = $1`, [done.revoke]);
    await expect(openAsWorker(done.org.orgId, done.revoke)).rejects.toMatchObject({ message: 'ADS_SEAL_GONE' });
  });

  it('holds the copy when the credential of an ads connection is dropped, by whatever path, once, for the approved providers only', async () => {
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

    // A Meta read connection whose recorded scopes hold a spend permission holds a token that can change campaigns: held, as the read kind, whatever the
    // reason it is closed for.
    for (const scope of ['ads_management', 'business_management']) {
      for (const reason of ['disconnected', 'spend_scopes']) {
        const read = await connection(org, { provider: 'meta_ads', scopes: ['ads_read', scope] });
        await close(org, read.id, reason);
        expect((await obligations(org.orgId, read.id))[0], `${scope} ${reason}`).toMatchObject({ kind: 'read_spend', provider: 'meta_ads', reason, seals: '1' });
      }
    }

    // Not held: a Meta read token with no spend permission (the fail-safe close of a reading connection is local), a provider outside the approved ones
    // (the sandbox's read token, Social's, any other platform's), a platform's own data deletion (the person already removed the app), and an org that is
    // not active (the purge wipes).
    const read = await connection(org, { provider: 'meta_ads', scopes: ['ads_read'] });
    await close(org, read.id, 'spend_scopes');
    const sandboxRead = await connection(org, { provider: 'sandbox_ads', scopes: ['ads_management'] });
    await close(org, sandboxRead.id);
    const social = await connection(org, { provider: 'facebook_page', scopes: ['ads_management'] });
    await close(org, social.id);
    const google = await connection(org, { provider: 'google_ads', scopes: ['ads_management'] });
    await close(org, google.id);
    const deleted = await connection(org, { provider: 'metawrite_ads' });
    await close(org, deleted.id, 'platform_deletion');
    for (const none of [read.id, sandboxRead.id, social.id, google.id, deleted.id]) expect(await obligations(org.orgId, none), none).toEqual([]);
    // A closed org holds nothing; an org in offboarding still holds (its owner may disconnect in that window; the purge wipes what is left).
    const closed = await makeOrg();
    const inClosed = await connection(closed, { provider: 'metawrite_ads' });
    const leaving = await makeOrg();
    const inLeaving = await connection(leaving, { provider: 'metawrite_ads' });
    for (const [org, status] of [[closed, 'closed'], [leaving, 'offboarding']] as const) {
      await admin(async (c) => {
        await c.query('BEGIN');
        await c.query('SET LOCAL session_replication_role = replica');
        await c.query(`UPDATE crove_kernel.tenant SET status = $2 WHERE org_id = $1`, [org.orgId, status]);
        await c.query('COMMIT');
      });
    }
    await close(closed, inClosed.id);
    await close(leaving, inLeaving.id);
    expect(await obligations(closed.orgId)).toEqual([]);
    expect(await rows('SELECT 1 FROM crove_kernel.credential WHERE org_id = $1', [closed.orgId])).toEqual([]);
    expect((await obligations(leaving.orgId, inLeaving.id))[0]).toMatchObject({ state: 'pending', seals: '1' });
    // The erasure of an account closed under its own reason holds (the platform's deletion request was another person's), the request's own grant does not.
    const erased = await connection(org, { provider: 'metawrite_ads' });
    await close(org, erased.id, 'account_erased');
    expect((await obligations(org.orgId, erased.id))[0]).toMatchObject({ kind: 'write', reason: 'account_erased', seals: '1' });
  });

  it('records the grantor of the connection on the obligation, from the account that was linked to it, and none when none is recorded', async () => {
    const org = await makeOrg();
    const read = await connection(org, { provider: 'meta_ads', scopes: ['ads_read', 'ads_management'], external: 'act_77' });
    const accountId = await account(org, read.id, 'meta_ads', 'act_77', HASH);
    await close(org, read.id);
    expect((await obligations(org.orgId, read.id))[0]).toMatchObject({ kind: 'read_spend', grantor_hash: HASH });
    expect((await rows<{ ad_account_id: string }>('SELECT ad_account_id FROM crove_ads.ad_token_revoke WHERE org_id = $1 AND connection_id = $2', [org.orgId, read.id]))[0]?.ad_account_id).toBe(accountId);
    // A connection of no account has none: the revoke then runs, since nothing says another connection needs the grant.
    const unlinked = await connection(org, { provider: 'metawrite_ads' });
    await close(org, unlinked.id);
    expect((await obligations(org.orgId, unlinked.id))[0]?.grantor_hash).toBeNull();
    // Whoever connected it is recorded, whatever the grantor.
    expect((await rows<{ connected_by: string | null }>('SELECT connected_by FROM crove_ads.ad_token_revoke WHERE org_id = $1 AND connection_id = $2', [org.orgId, unlinked.id]))[0]?.connected_by).toBe(org.userId);
  });

  it('keeps an obligation to what it was born as: pending, with no tries, and never another connection, kind, reason or grantor', async () => {
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
    for (const [column, value] of [['kind', `'read_spend'`], ['reason', `'other'`], ['provider', `'meta_ads'`], ['external_account_id', `'y'`], ['grantor_hash', `'${HASH}'`], ['created_at', `now() + interval '1 day'`]]) {
      await expect(owner(`UPDATE crove_ads.ad_token_revoke SET ${column} = ${value} WHERE org_id = $1 AND id = $2`, [org.orgId, row?.id]), column).rejects.toMatchObject({ code: '42501', message: 'ADS_REVOKE_FORBIDDEN' });
    }
  });

  it('ends the copy only by a try that worked, the tenth try, the seventh day or the finding that nothing can be revoked, and the end is final', async () => {
    const { org, revoke } = await held();
    const update = (set: string) => owner(`UPDATE crove_ads.ad_token_revoke SET ${set} WHERE org_id = $1 AND id = $2`, [org.orgId, revoke]);
    const copies = async () => Number((await obligations(org.orgId))[0]?.seals);
    // Nothing ends it without the try: done with no try (but for the two that make no call), a give-up by attempts with fewer than ten, a give-up by age
    // before the seventh day.
    await expect(update(`state = 'done', how_done = 'revoked', next_attempt_at = NULL`)).rejects.toMatchObject({ code: '42501', message: 'ADS_REVOKE_FORBIDDEN' });
    await expect(update(`state = 'done', how_done = 'sandbox', next_attempt_at = NULL`)).rejects.toMatchObject({ code: '42501' });
    await expect(update(`state = 'done', how_done = 'already_invalid', next_attempt_at = NULL`)).rejects.toMatchObject({ code: '42501' });
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
    expect((await obligations(org.orgId))[0]).toMatchObject({ state: 'gave_up', attempts: 10, give_up: 'attempts', seals: '0' });
    // Final: nothing changes a settled obligation, not even to the same state.
    await expect(update(`state = 'done', how_done = 'revoked', next_attempt_at = NULL, attempts = 10`)).rejects.toMatchObject({ code: '42501', message: 'ADS_REVOKE_FORBIDDEN' });
    await expect(update(`last_error_code = 'LATE'`)).rejects.toMatchObject({ code: '42501' });
  });

  it('ends the copy when the revoke worked, when another live connection needs the grant, and when nothing can be revoked, in the same statement', async () => {
    const worked = await held();
    await owner(`UPDATE crove_ads.ad_token_revoke SET state = 'done', how_done = 'revoked', next_attempt_at = NULL, attempts = 1 WHERE org_id = $1 AND id = $2`, [worked.org.orgId, worked.revoke]);
    const [row] = await rows<{ state: string; how_done: string; settled: boolean; seals: string }>(
      `SELECT r.state, r.how_done, r.settled_at IS NOT NULL AS settled, (SELECT count(*)::text FROM crove_ads.ad_token_seal s WHERE s.org_id = r.org_id) AS seals FROM crove_ads.ad_token_revoke r WHERE r.org_id = $1 AND r.id = $2`,
      [worked.org.orgId, worked.revoke],
    );
    expect(row).toEqual({ state: 'done', how_done: 'revoked', settled: true, seals: '0' });
    // A copy that is gone is gone for the worker too.
    await expect(openAsWorker(worked.org.orgId, worked.revoke)).rejects.toMatchObject({ message: 'ADS_SEAL_GONE' });

    // Another live connection of the same person needs the grant: no call was made, so no try is needed.
    const shared = await held();
    await owner(`UPDATE crove_ads.ad_token_revoke SET state = 'done', how_done = 'shared_grant', next_attempt_at = NULL WHERE org_id = $1 AND id = $2`, [shared.org.orgId, shared.revoke]);
    expect((await obligations(shared.org.orgId))[0]).toMatchObject({ state: 'done', how_done: 'shared_grant', attempts: 0, seals: '0' });

    // Nothing can be revoked from the copy (the platform refuses the token for another reason than the person removing the app, the copy does not open, the
    // deployment has no way to call the platform): given up and wiped at once, to be revoked by hand, whatever the count.
    const nothing = await held();
    await owner(`UPDATE crove_ads.ad_token_revoke SET state = 'gave_up', give_up = 'unrevocable', next_attempt_at = NULL, last_error_code = 'OPEN_FAILED' WHERE org_id = $1 AND id = $2`, [nothing.org.orgId, nothing.revoke]);
    expect((await obligations(nothing.org.orgId))[0]).toMatchObject({ state: 'gave_up', give_up: 'unrevocable', seals: '0' });
  });

  it('wipes what is past seven days or ten tries by the sweep alone, with no job: a backdated obligation, a backdated copy, a tenth open nobody answered', async () => {
    const old = await held();
    const oldCopy = await held();
    const young = await held();
    const lapsed = await held();
    // The only way to make an obligation old is to change its birth: the guard is switched off for that one statement, as the owner of the table.
    await admin(async (c) => {
      await c.query('ALTER TABLE crove_ads.ad_token_revoke DISABLE TRIGGER ad_token_revoke_guard');
      try {
        await c.query(`UPDATE crove_ads.ad_token_revoke SET created_at = now() - interval '8 days' WHERE org_id = $1 AND id = $2`, [old.org.orgId, old.revoke]);
        await c.query(`UPDATE crove_ads.ad_token_revoke SET created_at = now() - interval '6 days 23 hours' WHERE org_id = $1 AND id = $2`, [young.org.orgId, young.revoke]);
        // A tenth open the worker never answered: ten tries, the lease run out.
        await c.query(`UPDATE crove_ads.ad_token_revoke SET attempts = 10, next_attempt_at = now() - interval '1 minute' WHERE org_id = $1 AND id = $2`, [lapsed.org.orgId, lapsed.revoke]);
        await c.query(`UPDATE crove_ads.ad_token_seal SET lease_until = now() - interval '1 minute', lease_token = $3 WHERE org_id = $1 AND revoke_id = $2`, [lapsed.org.orgId, lapsed.revoke, randomUUID()]);
      } finally {
        await c.query('ALTER TABLE crove_ads.ad_token_revoke ENABLE ALWAYS TRIGGER ad_token_revoke_guard');
      }
    });
    // A copy that is old while its obligation is young (the copy's own date).
    await owner(`UPDATE crove_ads.ad_token_seal SET sealed_at = now() - interval '8 days' WHERE org_id = $1 AND revoke_id = $2`, [oldCopy.org.orgId, oldCopy.revoke]);
    const swept = await workerSql<{ n: number }>('SELECT crove_ads.token_revoke_expire() AS n');
    expect(swept[0]?.n).toBeGreaterThanOrEqual(3);
    const state = (orgId: string) =>
      rows<{ state: string; give_up: string | null; attempts: number; next: Date | null; seals: string }>(
        `SELECT r.state, r.give_up, r.attempts, r.next_attempt_at AS next, (SELECT count(*)::text FROM crove_ads.ad_token_seal s WHERE s.org_id = r.org_id) AS seals FROM crove_ads.ad_token_revoke r WHERE r.org_id = $1`,
        [orgId],
      );
    expect(await state(old.org.orgId)).toEqual([{ state: 'gave_up', give_up: 'age', attempts: 0, next: null, seals: '0' }]);
    expect(await state(oldCopy.org.orgId)).toEqual([{ state: 'gave_up', give_up: 'age', attempts: 0, next: null, seals: '0' }]);
    expect(await state(lapsed.org.orgId)).toEqual([{ state: 'gave_up', give_up: 'attempts', attempts: 10, next: null, seals: '0' }]);
    expect(await state(young.org.orgId)).toEqual([expect.objectContaining({ state: 'pending', seals: '1' })]);

    // A try that was opened and is not answered yet is left to answer, even past its age (the call that removes the grant may be in flight); once the open's
    // ten minutes have passed it is settled.
    const inFlight = await held();
    await dueNow(inFlight.revoke);
    await openAsWorker(inFlight.org.orgId, inFlight.revoke);
    await admin(async (c) => {
      await c.query('ALTER TABLE crove_ads.ad_token_revoke DISABLE TRIGGER ad_token_revoke_guard');
      try {
        await c.query(`UPDATE crove_ads.ad_token_revoke SET created_at = now() - interval '8 days' WHERE org_id = $1 AND id = $2`, [inFlight.org.orgId, inFlight.revoke]);
      } finally {
        await c.query('ALTER TABLE crove_ads.ad_token_revoke ENABLE ALWAYS TRIGGER ad_token_revoke_guard');
      }
    });
    await workerSql('SELECT crove_ads.token_revoke_expire()');
    expect(await state(inFlight.org.orgId)).toEqual([expect.objectContaining({ state: 'pending', attempts: 1, seals: '1' })]);
    await owner(`UPDATE crove_ads.ad_token_revoke SET next_attempt_at = now() - interval '1 minute' WHERE org_id = $1 AND id = $2`, [inFlight.org.orgId, inFlight.revoke]);
    await workerSql('SELECT crove_ads.token_revoke_expire()');
    expect(await state(inFlight.org.orgId)).toEqual([{ state: 'gave_up', give_up: 'age', attempts: 1, next: null, seals: '0' }]);
  });

  it('records the answer of one obligation without touching any other: the settle does not sweep other orgs', async () => {
    const answered = await held();
    const overdue = await held();
    await admin(async (c) => {
      await c.query('ALTER TABLE crove_ads.ad_token_revoke DISABLE TRIGGER ad_token_revoke_guard');
      try {
        await c.query(`UPDATE crove_ads.ad_token_revoke SET created_at = now() - interval '8 days' WHERE org_id = $1 AND id = $2`, [overdue.org.orgId, overdue.revoke]);
      } finally {
        await c.query('ALTER TABLE crove_ads.ad_token_revoke ENABLE ALWAYS TRIGGER ad_token_revoke_guard');
      }
    });
    const opened = await openAsWorker(answered.org.orgId, answered.revoke);
    await workerSql("SELECT crove_ads.token_revoke_settle($1::uuid, $2::uuid, $3::uuid, 'pending', now() + interval '1 minute', NULL, NULL, NULL, NULL)", [answered.org.orgId, answered.revoke, opened.token]);
    // The other org's overdue obligation is still there for the sweep to settle: a command in one org's context never rewrites another's rows.
    expect((await obligations(overdue.org.orgId))[0]).toMatchObject({ state: 'pending', seals: '1' });
  });

  it('claims a due obligation once: a second claim within the lease finds it taken, a claim is not a try, and a lapsed lease is taken again with a new token', async () => {
    const { org, revoke } = await held();
    const claim = async () => (await workerSql<{ org_id: string; id: string; lease_token: string }>('SELECT org_id, id, lease_token FROM crove_ads.token_revoke_due(100)')).filter((r) => r.id === revoke);
    const first = await claim();
    expect(first).toHaveLength(1);
    expect(await claim()).toHaveLength(0);
    // The lease is ten minutes; the count did not move, since a claim is not a try, and the next time is still the obligation's own.
    const [row] = await rows<{ minutes: number; attempts: number; due: boolean }>(
      `SELECT extract(epoch FROM (s.lease_until - now())) / 60 AS minutes, r.attempts, r.next_attempt_at <= now() AS due
       FROM crove_ads.ad_token_revoke r JOIN crove_ads.ad_token_seal s ON s.org_id = r.org_id AND s.revoke_id = r.id WHERE r.org_id = $1 AND r.id = $2`,
      [org.orgId, revoke],
    );
    expect(Number(row?.minutes)).toBeGreaterThan(8);
    expect(Number(row?.minutes)).toBeLessThanOrEqual(10);
    expect(row).toMatchObject({ attempts: 0, due: true });
    // The token is the seal's, which no role can read: the state table has no such column.
    expect((await rows('SELECT 1 FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 AND column_name LIKE $3', ['crove_ads', 'ad_token_revoke', 'lease%'])).length).toBe(0);
    // A claim whose lease ran out is taken again, with a token of its own.
    await owner(`UPDATE crove_ads.ad_token_seal SET lease_until = now() - interval '1 second' WHERE revoke_id = $1`, [revoke]);
    const second = await claim();
    expect(second).toHaveLength(1);
    expect(second[0]?.lease_token).not.toBe(first[0]?.lease_token);
  });

  it('refuses the answer of a run that stalled past its lease once a newer run has claimed the obligation, and an answer twice', async () => {
    const { org, revoke } = await held();
    const settle = (token: string | null, state = 'pending', how: string | null = null) =>
      workerSql("SELECT crove_ads.token_revoke_settle($1::uuid, $2::uuid, $3::uuid, $4, now() + interval '1 minute', $5, NULL, NULL, NULL)", [org.orgId, revoke, token, state, how]);
    // The first run claims and opens (try 1), then stalls: its lease runs out and the open's own wait passes.
    const stalled = await openAsWorker(org.orgId, revoke);
    expect(stalled.token).toBeTruthy();
    await dueNow(revoke);
    // A newer run claims the same obligation (a new token) and opens it (try 2).
    const newer = await openAsWorker(org.orgId, revoke);
    expect(newer.token).toBeTruthy();
    expect(newer.token).not.toBe(stalled.token);
    expect((await obligations(org.orgId))[0]?.attempts).toBe(2);
    // The stalled run answers late: refused, and nothing changed.
    await expect(settle(stalled.token)).rejects.toMatchObject({ message: 'ADS_REVOKE_STALE' });
    await expect(settle(null)).rejects.toMatchObject({ message: 'ADS_REVOKE_STALE' });
    await expect(settle(randomUUID())).rejects.toMatchObject({ message: 'ADS_REVOKE_STALE' });
    expect((await obligations(org.orgId))[0]).toMatchObject({ state: 'pending', attempts: 2, seals: '1' });
    // The newer run answers: accepted once; the same token cannot answer again.
    await settle(newer.token);
    await expect(settle(newer.token)).rejects.toMatchObject({ message: 'ADS_REVOKE_STALE' });
    expect((await obligations(org.orgId))[0]).toMatchObject({ state: 'pending', attempts: 2, seals: '1' });
    // A settled obligation has no copy and no claim: nothing answers it any more.
    await dueNow(revoke);
    const last = await openAsWorker(org.orgId, revoke);
    await settle(last.token, 'done', 'revoked');
    expect((await obligations(org.orgId))[0]).toMatchObject({ state: 'done', how_done: 'revoked', seals: '0' });
    await expect(settle(last.token, 'done', 'revoked')).rejects.toMatchObject({ message: 'ADS_REVOKE_STALE' });
  });

  it('holds exactly one copy on every path that deletes the credential or the connection, and none on an update of the credential', async () => {
    const org = await makeOrg();
    const count = async (id: string) => (await obligations(org.orgId, id)).length;
    const seals = async (id: string) => Number((await obligations(org.orgId, id))[0]?.seals ?? 0);
    // The credential is dropped by a statement of its own (the kernel's definers do that).
    const dropped = await connection(org, { provider: 'metawrite_ads' });
    await owner('DELETE FROM crove_kernel.credential WHERE org_id = $1 AND connection_id = $2', [org.orgId, dropped.id]);
    expect([await count(dropped.id), await seals(dropped.id)]).toEqual([1, 1]);
    // The connection row is deleted: its credential cascades after it, and the copy is made once, before it goes.
    const cascaded = await connection(org, { provider: 'sandboxwrite_ads' });
    await owner('DELETE FROM crove_kernel.channel_connection WHERE org_id = $1 AND id = $2', [org.orgId, cascaded.id]);
    expect(await rows('SELECT 1 FROM crove_kernel.credential WHERE org_id = $1 AND connection_id = $2', [org.orgId, cascaded.id])).toEqual([]);
    expect([await count(cascaded.id), await seals(cascaded.id)]).toEqual([1, 1]);
    const copy = await rows<{ envelope: Buffer }>('SELECT s.envelope FROM crove_ads.ad_token_seal s JOIN crove_ads.ad_token_revoke r ON r.org_id = s.org_id AND r.id = s.revoke_id WHERE r.connection_id = $1', [cascaded.id]);
    expect(copy[0]?.envelope.equals(cascaded.envelope)).toBe(true);
    // A closed connection (the status and its reason, then the credential) holds one; a credential put back and dropped again, then the connection row
    // deleted, holds no second.
    const closed = await connection(org, { provider: 'metawrite_ads' });
    await close(org, closed.id);
    expect([await count(closed.id), await seals(closed.id)]).toEqual([1, 1]);
    await owner('INSERT INTO crove_kernel.credential (org_id, connection_id, key_id, envelope) VALUES ($1, $2, $3, $4)', [org.orgId, closed.id, 'k9', Buffer.from('again')]);
    await owner('DELETE FROM crove_kernel.credential WHERE org_id = $1 AND connection_id = $2', [org.orgId, closed.id]);
    await owner('DELETE FROM crove_kernel.channel_connection WHERE org_id = $1 AND id = $2', [org.orgId, closed.id]);
    expect([await count(closed.id), await seals(closed.id)]).toEqual([1, 1]);
    // An update of the credential (a reseal in a key rotation) holds nothing, and neither does a provider outside the approved ones, or a platform's deletion.
    const live = await connection(org, { provider: 'metawrite_ads' });
    await owner(`UPDATE crove_kernel.credential SET key_id = 'k2', envelope = $3, sealed_at = now() WHERE org_id = $1 AND connection_id = $2`, [org.orgId, live.id, Buffer.from('resealed')]);
    expect(await count(live.id)).toBe(0);
    for (const provider of ['facebook_page', 'google_ads', 'sandbox_ads']) {
      const other = await connection(org, { provider, scopes: ['ads_management'] });
      await owner('DELETE FROM crove_kernel.channel_connection WHERE org_id = $1 AND id = $2', [org.orgId, other.id]);
      expect(await count(other.id), provider).toBe(0);
    }
    const deleted = await connection(org, { provider: 'metawrite_ads' });
    await owner(`UPDATE crove_kernel.channel_connection SET status = 'revoked', status_reason = 'platform_deletion' WHERE org_id = $1 AND id = $2`, [org.orgId, deleted.id]);
    await owner('DELETE FROM crove_kernel.channel_connection WHERE org_id = $1 AND id = $2', [org.orgId, deleted.id]);
    expect(await count(deleted.id)).toBe(0);
    // The connection row of a copy that is held was deleted with nothing in the way, and the copy is still there.
    expect(await seals(cascaded.id)).toBe(1);
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
    expect((await obligations(org.orgId, conn.id))[0]).toMatchObject({ state: 'pending', attempts: 0, seals: '1' });
    // Removal wiped nothing and counted no try; the open serves the removed member's copy, and the try is counted as it opens.
    const opened = await openAsWorker(org.orgId, row?.id as string);
    expect(opened[0]?.envelope.equals(conn.envelope)).toBe(true);
    expect((await obligations(org.orgId, conn.id))[0]).toMatchObject({ state: 'pending', attempts: 1, seals: '1' });
    // The kernel's own door for the credential of an open connection does ask who connected it; this one does not, and only the worker has it.
    await owner(`UPDATE crove_ads.ad_token_revoke SET state = 'done', how_done = 'revoked', next_attempt_at = NULL WHERE org_id = $1 AND id = $2`, [org.orgId, row?.id]);
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
    // Not an ad write connection: never listed, whoever connected it.
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

  it('cancels the pending revoke of an account when it is connected again, and wipes the copy in the same transaction; a reseal of the key does not', async () => {
    const org = await makeOrg();
    const first = await connection(org, { provider: 'metawrite_ads', external: 'act_900' });
    await close(org, first.id);
    expect((await obligations(org.orgId, first.id))[0]).toMatchObject({ state: 'pending', seals: '1' });
    // Another account and another provider are not this account.
    const otherAccount = await connection(org, { provider: 'metawrite_ads', external: 'act_901' });
    await close(org, otherAccount.id);
    const otherProvider = await connection(org, { provider: 'sandboxwrite_ads', external: 'act_900' });
    await close(org, otherProvider.id);
    // A reseal updates the credential row of a live connection of the account: it is no reconnect. (A pending revoke of the same account made after the live
    // connection exists, as a replacement leaves one, is put there as the owner of the table; a reseal of the live credential then leaves it pending.)
    const live = await connection(org, { provider: 'metawrite_ads', external: 'act_902' });
    const closedConn = randomUUID();
    await owner(
      `INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, status, status_reason, connected_by) VALUES ($1, $2, 'metawrite_ads', 'act_902', 'Cũ', 'revoked', 'disconnected', $3)`,
      [org.orgId, closedConn, org.userId],
    );
    await owner(`INSERT INTO crove_ads.ad_token_revoke (org_id, connection_id, provider, external_account_id, kind, reason) VALUES ($1, $2, 'metawrite_ads', 'act_902', 'write', 'disconnected')`, [org.orgId, closedConn]);
    await owner(`UPDATE crove_kernel.credential SET key_id = 'k2', envelope = $3 WHERE org_id = $1 AND connection_id = $2`, [org.orgId, live.id, Buffer.from('resealed')]);
    expect((await obligations(org.orgId, closedConn))[0]).toMatchObject({ state: 'pending' });
    // The person connects the account again: a new connection with a sealed credential, in the transaction that seals it.
    const again = await connection(org, { provider: 'metawrite_ads', external: 'act_900' });
    expect(again.id).not.toBe(first.id);
    expect((await obligations(org.orgId, first.id))[0]).toMatchObject({ state: 'done', how_done: 'reconnected', seals: '0' });
    expect((await obligations(org.orgId, otherAccount.id))[0]).toMatchObject({ state: 'pending', seals: '1' });
    expect((await obligations(org.orgId, otherProvider.id))[0]).toMatchObject({ state: 'pending', seals: '1' });
    // Another member's connection of the account does not cancel the first member's revoke: the first member's grant at the platform stands.
    const second = await upsertIdentity(createDb(pool), { issuer: 'test', subject: `second-${randomUUID().slice(0, 8)}`, email: `second-${randomUUID().slice(0, 8)}@seal.test`, name: null });
    const theirs = await connection(org, { provider: 'metawrite_ads', external: 'act_950' });
    await close(org, theirs.id);
    expect((await obligations(org.orgId, theirs.id))[0]).toMatchObject({ state: 'pending', seals: '1' });
    await connection({ orgId: org.orgId, userId: second }, { provider: 'metawrite_ads', external: 'act_950' });
    expect((await obligations(org.orgId, theirs.id))[0]).toMatchObject({ state: 'pending', seals: '1' });
  });

  it('says whether another live connection of the same grantor needs the grant, as a boolean and nothing else, across orgs', async () => {
    const mine = await makeOrg();
    const read = await connection(mine, { provider: 'meta_ads', scopes: ['ads_read', 'ads_management'], external: 'act_500' });
    await account(mine, read.id, 'meta_ads', 'act_500', HASH);
    await close(mine, read.id);
    const [row] = await obligations(mine.orgId, read.id);
    const shared = async () => (await workerSql<{ shared: boolean }>('SELECT crove_ads.token_grant_shared($1::uuid, $2::uuid) AS shared', [mine.orgId, row?.id]))[0]?.shared;
    // Nothing else of that person: the revoke runs.
    expect(await shared()).toBe(false);
    // Another org's live connection granted by the same person (a hash is a keyed digest, the same for one person and one app): it needs the grant.
    const theirs = await makeOrg();
    const theirConn = await connection(theirs, { provider: 'meta_ads', scopes: ['ads_read'], external: 'act_501' });
    await account(theirs, theirConn.id, 'meta_ads', 'act_501', HASH);
    expect(await shared()).toBe(true);
    // A closed connection, another person's, and an org that is not active do not count.
    await close(theirs, theirConn.id, 'disconnected');
    expect(await shared()).toBe(false);
    const stranger = await makeOrg();
    const strangerConn = await connection(stranger, { provider: 'meta_ads', external: 'act_502' });
    await account(stranger, strangerConn.id, 'meta_ads', 'act_502', 'b'.repeat(64));
    expect(await shared()).toBe(false);
    const closing = await makeOrg();
    const closingConn = await connection(closing, { provider: 'meta_ads', external: 'act_503' });
    await account(closing, closingConn.id, 'meta_ads', 'act_503', HASH);
    expect(await shared()).toBe(true);
    await admin(async (c) => {
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query(`UPDATE crove_kernel.tenant SET status = 'offboarding' WHERE org_id = $1`, [closing.orgId]);
      await c.query('COMMIT');
    });
    expect(await shared()).toBe(false);
    // Its own connection never counts, and an obligation whose grantor is not known is never shared; a settled or unknown obligation answers false.
    const unlinked = await connection(mine, { provider: 'metawrite_ads' });
    await close(mine, unlinked.id);
    const [none] = await obligations(mine.orgId, unlinked.id);
    expect((await workerSql<{ shared: boolean }>('SELECT crove_ads.token_grant_shared($1::uuid, $2::uuid) AS shared', [mine.orgId, none?.id]))[0]?.shared).toBe(false);
    // With no grantor recorded the person is unknown: the same member's other live connection of the same provider, in any org, is taken to be theirs, and the
    // call that would cut it is not made; once it is closed (or if it is another member's) the call is made.
    const theirOrg = await makeOrg();
    const sameMember = await connection({ orgId: theirOrg.orgId, userId: mine.userId }, { provider: 'metawrite_ads', external: 'act_600' });
    expect((await workerSql<{ shared: boolean }>('SELECT crove_ads.token_grant_shared($1::uuid, $2::uuid) AS shared', [mine.orgId, none?.id]))[0]?.shared).toBe(true);
    await close(theirOrg, sameMember.id);
    expect((await workerSql<{ shared: boolean }>('SELECT crove_ads.token_grant_shared($1::uuid, $2::uuid) AS shared', [mine.orgId, none?.id]))[0]?.shared).toBe(false);
    await connection(theirOrg, { provider: 'metawrite_ads', external: 'act_601' });
    expect((await workerSql<{ shared: boolean }>('SELECT crove_ads.token_grant_shared($1::uuid, $2::uuid) AS shared', [mine.orgId, none?.id]))[0]?.shared).toBe(false);
    expect((await workerSql<{ shared: boolean }>('SELECT crove_ads.token_grant_shared($1::uuid, $2::uuid) AS shared', [mine.orgId, randomUUID()]))[0]?.shared).toBe(false);
  });

  it('wipes the copy and the state at once when the org is purged, and the purge holds nothing new', async () => {
    const org = await makeOrg();
    const write = await connection(org, { provider: 'metawrite_ads' });
    await close(org, write.id);
    // A connection that is still open when the purge runs: the purge drops its credential, which must not make a new copy.
    const open = await connection(org, { provider: 'metawrite_ads' });
    expect((await obligations(org.orgId)).map((o) => o.seals)).toEqual(['1']);
    await offboard(org);
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

  it('leaves no copy behind when a close races the purge, in either order, and a job for a purged org finds nothing', async () => {
    // The org is offboarding with its export recorded as in a purge's own test; the staff step is a status change and two audit rows.
    async function offboardingOrg() {
      const org = await makeOrg();
      const conn = await connection(org, { provider: 'metawrite_ads' });
      await offboard(org);
      return { org, conn };
    }
    // 1. The org is in offboarding: a close still holds, and the purge that follows deletes it and holds nothing for the credentials it drops.
    {
      const { org, conn } = await offboardingOrg();
      const other = await connection(org, { provider: 'metawrite_ads' });
      await close(org, conn.id);
      expect((await obligations(org.orgId, conn.id))[0]).toMatchObject({ state: 'pending', seals: '1' });
      await expect(purgeOrg(worker, 30, { ref: org.orgId, reason: 'test' })).resolves.toMatchObject({ kind: 'purged', orgId: org.orgId });
      expect(await obligations(org.orgId)).toEqual([]);
      expect(await rows('SELECT 1 FROM crove_ads.ad_token_seal WHERE org_id = $1', [org.orgId])).toEqual([]);
      expect(await rows('SELECT 1 FROM crove_kernel.credential WHERE org_id = $1 AND connection_id = $2', [org.orgId, other.id])).toEqual([]);
    }
    // 2. A close that began while the org was active and is not committed holds the org's row (FOR SHARE, taken by the hold): the staff step that takes the
    // org out of service waits for it, so the close finishes first, its copy exists, and the purge that follows deletes it.
    {
      const org = await makeOrg();
      const conn = await connection(org, { provider: 'metawrite_ads' });
      const closing = new pg.Client({ connectionString: adminUrl });
      await closing.connect();
      try {
        await closing.query('BEGIN');
        await closing.query(`UPDATE crove_kernel.channel_connection SET status = 'revoked', status_reason = 'disconnected' WHERE org_id = $1 AND id = $2`, [org.orgId, conn.id]);
        await closing.query('DELETE FROM crove_kernel.credential WHERE org_id = $1 AND connection_id = $2', [org.orgId, conn.id]);
        const offboarding = offboard(org);
        const early = await Promise.race([offboarding.then(() => 'finished'), new Promise((resolve) => setTimeout(() => resolve('waiting'), 1500))]);
        expect(early, 'the status change waits for the close that holds the org row').toBe('waiting');
        await closing.query('COMMIT');
        await offboarding;
      } finally {
        await closing.query('ROLLBACK').catch(() => undefined);
        await closing.end();
      }
      expect((await obligations(org.orgId, conn.id))[0]).toMatchObject({ state: 'pending', seals: '1' });
      await expect(purgeOrg(worker, 30, { ref: org.orgId, reason: 'test' })).resolves.toMatchObject({ kind: 'purged', orgId: org.orgId });
      expect(await obligations(org.orgId)).toEqual([]);
      expect(await rows('SELECT 1 FROM crove_ads.ad_token_seal WHERE org_id = $1', [org.orgId])).toEqual([]);
    }
    // 3. A copy held before the purge is deleted by it, and a job for the purged org finds no copy.
    {
      const org = await makeOrg();
      const conn = await connection(org, { provider: 'metawrite_ads' });
      const held = await close(org, conn.id).then(() => obligations(org.orgId, conn.id));
      const revoke = held[0]?.id as string;
      await offboard(org);
      await expect(purgeOrg(worker, 30, { ref: org.orgId, reason: 'test' })).resolves.toMatchObject({ kind: 'purged' });
      await dueNow(revoke);
      await expect(openAsWorker(org.orgId, revoke)).rejects.toBeDefined();
      expect(await obligations(org.orgId)).toEqual([]);
    }
  });

  // An org in offboarding with an export of the current format recorded 31 days ago, set up as staff (as the purge's own test does). The status change takes
  // the org's row, so it waits for a close that holds it.
  async function offboard(org: { orgId: string; userId: string }) {
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
  }
});

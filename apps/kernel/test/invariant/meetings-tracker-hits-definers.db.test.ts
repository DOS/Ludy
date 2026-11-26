// SPDX-License-Identifier: AGPL-3.0-only
// DB invariants for the three functions that count a tracked word in meeting text (#5044 item 4, the Platform PO's note on #5041; plan rows L22 and L28):
//   - ludy_meetings.tracker_alert_hits(uuid, uuid, timestamptz)   the alert's count, a SECURITY DEFINER the worker alone may run;
//   - ludy_meetings.weekly_tracked_hits(uuid, uuid, timestamptz)  the weekly notice's count for one member, the same shape;
//   - ludy_meetings.tracker_hits_in(uuid, uuid)                   the counting helper both use, SECURITY INVOKER and runnable by no role but its owner.
// Each of them reads the transcript of meetings a caller may not be allowed to read, so what is pinned is who can reach them and how: the kind of security, the search path, the EXECUTE list (the worker on
// the two definers, nobody on the helper, PUBLIC on none), and the refusal of a call made without a system context. The pin states the shape every migration of these functions ends in, so the later
// restatement of weekly_tracked_hits (its own org and account checks, #5044 item 1) passes it unchanged.
// Additive: the module's own tests (meetings-tracker-alerts.db.test.ts, meetings-weekly.db.test.ts) keep their copies of these checks; moving them here is a second step.
// Part of the invariant suite: its fixtures are its own, and it imports package code under test, never helpers from outside test/invariant/. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run
// makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '@ludy/db/migrate';
import {
  auditRoleFunctionExecute,
  createDbClient,
  createRawPool,
  resolveDbIdentifiers,
  setActiveRolePasswords,
  type DbIdentifiers,
} from './fixtures/db-identifiers.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));

// The signatures as the invariant suite names them (the harness maps the module's schema to the active brand).
const ALERT = 'crove_meetings.tracker_alert_hits(uuid,uuid,timestamptz)';
const WEEKLY = 'crove_meetings.weekly_tracked_hits(uuid,uuid,timestamptz)';
const HELPER = 'crove_meetings.tracker_hits_in(uuid,uuid)';
const DEFINERS = [ALERT, WEEKLY] as const;
const SEARCH_PATH = 'search_path=pg_catalog, pg_temp';

// A role name as the invariant suite writes it, whichever brand the database carries.
const canonical = (role: string): string => role.replace(/^(crove|ludy)_/, 'crove_');

describe.skipIf(!ADMIN)('the tracked-word counting functions: who may run them, and how (#5044)', () => {
  const dbName = `ludy_test_tracker_hits_inv_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let dbIds: DbIdentifiers;
  let adminClient: pg.Client;
  let appPool: pg.Pool;
  let workerClient: pg.Client;

  beforeAll(async () => {
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();

    const dbBase = new URL(ADMIN as string);
    dbBase.pathname = `/${dbName}`;
    adminUrl = dbBase.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    dbIds = await resolveDbIdentifiers(adminUrl);
    await setActiveRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' }, dbIds);

    const app = new URL(adminUrl);
    app.username = dbIds.roleName('crove_app');
    app.password = 'test-app-pw';
    const worker = new URL(adminUrl);
    worker.username = dbIds.roleName('crove_worker');
    worker.password = 'test-worker-pw';

    adminClient = createDbClient({ connectionString: adminUrl }, dbIds);
    await adminClient.connect();
    appPool = createRawPool({ connectionString: app.toString(), max: 4 }, dbIds);
    workerClient = createDbClient({ connectionString: worker.toString() }, dbIds);
    await workerClient.connect();
  }, 120_000);

  afterAll(async () => {
    await workerClient?.end().catch(() => undefined);
    await appPool?.end().catch(() => undefined);
    await adminClient?.end().catch(() => undefined);
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  const resolved = (signature: string): string => dbIds.rewriteSql(signature);

  it('has the two counting definers SECURITY DEFINER and the helper SECURITY INVOKER, each with its search_path pinned', async () => {
    const expected: Array<[string, boolean]> = [
      [ALERT, true],
      [WEEKLY, true],
      [HELPER, false],
    ];
    for (const [signature, definer] of expected) {
      const { rows } = await adminClient.query<{ secdef: boolean; config: string[] | null }>(
        `SELECT p.prosecdef AS secdef, p.proconfig AS config FROM pg_catalog.pg_proc p WHERE p.oid = pg_catalog.to_regprocedure($1::text)::oid`,
        [resolved(signature)],
      );
      expect(rows, `${signature} exists`).toHaveLength(1);
      expect(rows[0]?.secdef, `${signature} ${definer ? 'is SECURITY DEFINER' : 'is SECURITY INVOKER'}`).toBe(definer);
      expect(rows[0]?.config ?? [], `${signature} pins search_path`).toContain(SEARCH_PATH);
    }
  });

  it('grants EXECUTE on the two definers to the worker alone and on the helper to nobody, PUBLIC and every other role included', async () => {
    const granted = async (signature: string): Promise<string[]> => {
      const { rows } = await adminClient.query<{ grantee: string }>(
        `SELECT COALESCE(r.rolname, 'PUBLIC') AS grantee
           FROM pg_catalog.pg_proc p
           CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
           LEFT JOIN pg_catalog.pg_roles r ON r.oid = a.grantee
          WHERE p.oid = pg_catalog.to_regprocedure($1::text)::oid AND a.privilege_type = 'EXECUTE' AND a.grantee <> p.proowner
          ORDER BY 1`,
        [resolved(signature)],
      );
      return rows.map((r) => canonical(r.grantee));
    };
    for (const signature of DEFINERS) {
      expect(await granted(signature), `${signature} is granted to the worker alone`).toEqual(['crove_worker']);
      // What each login can really do, membership included: the worker may, no other role that is not a superuser or a built-in one may.
      const { rows, activeAllowed } = await auditRoleFunctionExecute(adminClient, dbIds, signature, ['crove_worker'], 'non_system');
      expect(rows.some((r) => r.rolname === activeAllowed[0] && r.ok), `active role ${activeAllowed[0]} executes ${signature}`).toBe(true);
      expect(rows.filter((r) => r.ok !== r.expected), `${signature}: a role whose EXECUTE is not the worker's`).toEqual([]);
    }
    expect(await granted(HELPER), `${HELPER} is granted to no role but its owner`).toEqual([]);
    const audit = await auditRoleFunctionExecute(adminClient, dbIds, HELPER, [], 'non_system');
    expect(audit.rows.length, 'the audit covers the roles of the cluster').toBeGreaterThan(0);
    expect(audit.rows.filter((r) => r.ok), `${HELPER}: a role that can run the helper`).toEqual([]);
  });

  it('refuses every call made without a system context: the worker login is told NO_CONTEXT by the definers and denied the helper, and the API login is denied all three', async () => {
    const org = randomUUID();
    const meeting = randomUUID();
    const member = randomUUID();
    // The worker's own login, with no context set: the definers answer NO_CONTEXT (42501) before they read a row; the helper is not for the worker, so it is a permission error.
    await expect(workerClient.query('SELECT * FROM crove_meetings.tracker_alert_hits($1::uuid, $2::uuid, now())', [org, meeting])).rejects.toMatchObject({
      code: '42501',
      message: expect.stringContaining('NO_CONTEXT'),
    });
    await expect(workerClient.query('SELECT crove_meetings.weekly_tracked_hits($1::uuid, $2::uuid, now())', [org, member])).rejects.toMatchObject({
      code: '42501',
      message: expect.stringContaining('NO_CONTEXT'),
    });
    await expect(workerClient.query('SELECT * FROM crove_meetings.tracker_hits_in($1::uuid, $2::uuid)', [org, meeting])).rejects.toMatchObject({
      code: '42501',
      message: expect.stringContaining('permission denied for function tracker_hits_in'),
    });
    // The API login holds no EXECUTE on any of them: the call stops at a permission check (the function's, or the schema's before it), never reaching the context gate.
    await expect(appPool.query('SELECT * FROM crove_meetings.tracker_alert_hits($1::uuid, $2::uuid, now())', [org, meeting])).rejects.toMatchObject({
      code: '42501',
      message: expect.stringContaining('permission denied'),
    });
    await expect(appPool.query('SELECT crove_meetings.weekly_tracked_hits($1::uuid, $2::uuid, now())', [org, member])).rejects.toMatchObject({
      code: '42501',
      message: expect.stringContaining('permission denied'),
    });
    await expect(appPool.query('SELECT * FROM crove_meetings.tracker_hits_in($1::uuid, $2::uuid)', [org, meeting])).rejects.toMatchObject({
      code: '42501',
      message: expect.stringContaining('permission denied'),
    });
  });
});

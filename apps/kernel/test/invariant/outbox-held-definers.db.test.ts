// SPDX-License-Identifier: AGPL-3.0-only
// The functions on the events that wait while an app is off (ADR-0053, slice c C3b) are the worker's alone, refuse a malformed call, and the table behind them is no login role's
// (PostgreSQL 17). Set CROVE_TEST_ADMIN_URL to a superuser URL.
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

const FUNCTIONS = [
  'crove_kernel.outbox_hold(uuid[], uuid[], text[])',
  'crove_kernel.outbox_hold_pairs(integer, uuid, text)',
  'crove_kernel.outbox_release(uuid, text, integer)',
  'crove_kernel.outbox_held_expire(uuid, date, integer)',
];

suite('the held-event definers (ADR-0053, C3b)', () => {
  const dbName = `crove_test_heldinv_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appPool: pg.Pool;
  let workerPool: pg.Pool;

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
    workerPool = createPool({ connectionString: login('crove_worker', 'test-worker-pw'), max: 2 });
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

  it('grants every function to the worker alone', async () => {
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    try {
      const { rows } = await admin.query<{ fn: string; grantees: string[] }>(
        `SELECT f AS fn, COALESCE((SELECT array_agg(DISTINCT CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE (SELECT r.rolname FROM pg_roles r WHERE r.oid = x.grantee)::text END)
                                  FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) x WHERE x.grantee <> p.proowner), '{}'::text[]) AS grantees
         FROM unnest($1::text[]) f JOIN pg_proc p ON p.oid = f::regprocedure`,
        [FUNCTIONS],
      );
      expect(rows).toHaveLength(FUNCTIONS.length);
      for (const g of rows) expect(g.grantees, g.fn).toEqual(['crove_worker']);
    } finally {
      await admin.end();
    }
  });

  it('refuses the app login, a malformed call, and any read of the table', async () => {
    await expect(appPool.query('SELECT * FROM crove_kernel.outbox_hold_pairs(10, NULL, NULL)')).rejects.toMatchObject({ code: '42501' });
    await expect(appPool.query("SELECT * FROM crove_kernel.outbox_held_expire(gen_random_uuid(), '2020-01-01', 30)")).rejects.toMatchObject({ code: '42501' });
    await expect(workerPool.query('SELECT crove_kernel.outbox_hold(ARRAY[]::uuid[], ARRAY[gen_random_uuid()], ARRAY[]::text[])')).rejects.toMatchObject({ code: '22023' });
    await expect(workerPool.query('SELECT crove_kernel.outbox_release(NULL, NULL, 10)')).rejects.toMatchObject({ code: '22023' });
    await expect(workerPool.query('SELECT * FROM crove_kernel.outbox_hold_pairs(10, gen_random_uuid(), NULL)')).rejects.toMatchObject({ code: '22023' });
    await expect(workerPool.query("SELECT * FROM crove_kernel.outbox_held_expire(gen_random_uuid(), current_date, 30)")).rejects.toMatchObject({ code: '22023' });
    await expect(workerPool.query('SELECT * FROM crove_kernel.outbox_held')).rejects.toMatchObject({ code: '42501' });
    await expect(appPool.query('SELECT * FROM crove_kernel.outbox_held')).rejects.toMatchObject({ code: '42501' });
  });
});

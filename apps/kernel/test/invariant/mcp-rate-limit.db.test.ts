// SPDX-License-Identifier: AGPL-3.0-only
// DB invariants for ludy_kernel.mcp_rate_limit and mcp_rate_limit_take (#3978).

import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '@ludy/db/migrate';
import {
  auditRoleFunctionExecute,
  auditRoleTablePrivileges,
  createDbClient,
  createRawPool,
  resolveDbIdentifiers,
  setActiveRolePasswords,
  type DbIdentifiers,
} from './fixtures/db-identifiers.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const shaHex = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

describe.skipIf(!ADMIN)('mcp_rate_limit DB invariants (#3978)', () => {
  const dbName = `ludy_test_mcp_rl_inv_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let workerUrl = '';
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
    await setActiveRolePasswords(
      adminUrl,
      { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw', crove_prober: 'test-prober-pw' },
      dbIds,
    );

    const app = new URL(adminUrl);
    app.username = dbIds.roleName('crove_app');
    app.password = 'test-app-pw';
    appUrl = app.toString();

    const worker = new URL(adminUrl);
    worker.username = dbIds.roleName('crove_worker');
    worker.password = 'test-worker-pw';
    workerUrl = worker.toString();

    adminClient = createDbClient({ connectionString: adminUrl }, dbIds);
    await adminClient.connect();
    appPool = createRawPool({ connectionString: appUrl, max: 16 }, dbIds);
    workerClient = createDbClient({ connectionString: workerUrl }, dbIds);
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

  it('locks down table privileges, enables RLS with zero policies, installs agent_write_guard, and grants execute only to app', async () => {
    const { rows: execRows, activeAllowed } = await auditRoleFunctionExecute(
      adminClient,
      dbIds,
      'crove_kernel.mcp_rate_limit_take(text,text,integer,integer)',
      ['crove_app'],
      'non_system',
    );
    // The migration grants the function to the app login (20270324170000), so that role must show as able to run it: the audit saw the role and the function (#5033).
    expect(execRows.some((r) => r.rolname === activeAllowed[0] && r.ok), `active role ${activeAllowed[0]} executes mcp_rate_limit_take`).toBe(true);
    expect(execRows.filter((r) => r.ok !== r.expected)).toEqual([]);

    const publicExec = await adminClient.query<{ ok: boolean }>(
      `SELECT pg_catalog.has_function_privilege('public', 'crove_kernel.mcp_rate_limit_take(text,text,integer,integer)'::regprocedure, 'EXECUTE') AS ok`,
    );
    expect(publicExec.rows[0]?.ok).toBe(false);

    const privRows = await auditRoleTablePrivileges(
      adminClient,
      dbIds,
      'crove_kernel.mcp_rate_limit',
      ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
      'non_system',
    );
    // The audit covers every non-system role and the four rights (the app, worker and tenant logins exist in the test cluster), so it cannot come back empty (#5033).
    expect(privRows.length).toBeGreaterThan(0);
    expect(privRows.filter((r) => r.ok)).toEqual([]);

    const proc = await adminClient.query<{ prosecdef: boolean; proconfig: string[] | null }>(
      `SELECT p.prosecdef, p.proconfig
       FROM pg_catalog.pg_proc p
       JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = $1 AND p.proname = 'mcp_rate_limit_take'`,
      [dbIds.schema('kernel')],
    );
    expect(proc.rows).toEqual([{ prosecdef: true, proconfig: ['search_path=pg_catalog, pg_temp'] }]);

    const cls = await adminClient.query<{ relrowsecurity: boolean }>(
      `SELECT c.relrowsecurity
       FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = 'mcp_rate_limit'`,
      [dbIds.schema('kernel')],
    );
    expect(cls.rows[0]?.relrowsecurity).toBe(true);

    const policies = await adminClient.query<{ policyname: string }>(
      `SELECT policyname FROM pg_catalog.pg_policies WHERE schemaname = $1 AND tablename = 'mcp_rate_limit'`,
      [dbIds.schema('kernel')],
    );
    expect(policies.rows).toEqual([]);

    const guard = await adminClient.query<{ tgname: string }>(
      `SELECT t.tgname
       FROM pg_catalog.pg_trigger t
       JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = 'mcp_rate_limit' AND NOT t.tgisinternal AND t.tgname = 'agent_write_guard'`,
      [dbIds.schema('kernel')],
    );
    expect(guard.rows).toHaveLength(1);

    await expect(appPool.query('SELECT count(*) FROM crove_kernel.mcp_rate_limit')).rejects.toMatchObject({ code: '42501' });
    await expect(
      appPool.query(
        'INSERT INTO crove_kernel.mcp_rate_limit (bucket, key_hash, expires_at) VALUES ($1, $2, now())',
        ['mcp_addr', shaHex('x')],
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      workerClient.query('SELECT allowed, retry_after_seconds FROM crove_kernel.mcp_rate_limit_take($1, $2, $3, $4)', [
        'mcp_addr',
        shaHex('worker'),
        10,
        60,
      ]),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('rejects malformed arguments with SQLSTATE 22023', async () => {
    const validHash = shaHex('valid-key');
    const badCalls: Array<[string | null, string | null, number | null, number | null]> = [
      ['', validHash, 10, 60],
      ['A_UPPER', validHash, 10, 60],
      ['a', validHash, 10, 60],
      ['bad-dash', validHash, 10, 60],
      ['a'.repeat(42), validHash, 10, 60],
      [null, validHash, 10, 60],
      ['mcp_addr', 'not-hex', 10, 60],
      ['mcp_addr', '0'.repeat(63), 10, 60],
      ['mcp_addr', 'A'.repeat(64), 10, 60],
      ['mcp_addr', null, 10, 60],
      ['mcp_addr', validHash, 0, 60],
      ['mcp_addr', validHash, -1, 60],
      ['mcp_addr', validHash, 100001, 60],
      ['mcp_addr', validHash, null, 60],
      ['mcp_addr', validHash, 10, 0],
      ['mcp_addr', validHash, 10, -5],
      ['mcp_addr', validHash, 10, 86401],
      ['mcp_addr', validHash, 10, null],
    ];
    for (const args of badCalls) {
      await expect(
        appPool.query('SELECT allowed, retry_after_seconds FROM crove_kernel.mcp_rate_limit_take($1, $2, $3, $4)', args),
      ).rejects.toMatchObject({ code: '22023' });
    }
  });

  it('enforces exact limits under concurrent burst and isolates buckets and keys', async () => {
    const k1 = shaHex('burst-key-1');
    const k2 = shaHex('burst-key-2');
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        appPool.query<{ allowed: boolean; retry_after_seconds: number | null }>(
          'SELECT allowed, retry_after_seconds FROM crove_kernel.mcp_rate_limit_take($1, $2, $3, $4)',
          ['oauth_register_addr', k1, 5, 60],
        ),
      ),
    );
    const rows = results.map((r) => r.rows[0]!);
    const allowed = rows.filter((r) => r.allowed);
    const refused = rows.filter((r) => !r.allowed);
    expect(allowed).toHaveLength(5);
    expect(allowed.every((r) => r.retry_after_seconds === null)).toBe(true);
    expect(refused).toHaveLength(7);
    expect(refused.every((r) => (r.retry_after_seconds ?? 0) >= 1 && (r.retry_after_seconds ?? 0) <= 60)).toBe(true);

    const otherKey = await appPool.query<{ allowed: boolean }>(
      'SELECT allowed FROM crove_kernel.mcp_rate_limit_take($1, $2, $3, $4)',
      ['oauth_register_addr', k2, 5, 60],
    );
    expect(otherKey.rows[0]?.allowed).toBe(true);

    const otherBucket = await appPool.query<{ allowed: boolean }>(
      'SELECT allowed FROM crove_kernel.mcp_rate_limit_take($1, $2, $3, $4)',
      ['mcp_grant', k1, 5, 60],
    );
    expect(otherBucket.rows[0]?.allowed).toBe(true);
  });

  it('frees capacity after expiry and bounds expired-row cleanup to 100 rows per call', async () => {
    const key = shaHex('expiry-key');
    for (let i = 0; i < 2; i += 1) {
      const res = await appPool.query<{ allowed: boolean }>(
        'SELECT allowed FROM crove_kernel.mcp_rate_limit_take($1, $2, $3, $4)',
        ['oauth_pairing_addr', key, 2, 60],
      );
      expect(res.rows[0]?.allowed).toBe(true);
    }
    const blocked = await appPool.query<{ allowed: boolean; retry_after_seconds: number | null }>(
      'SELECT allowed, retry_after_seconds FROM crove_kernel.mcp_rate_limit_take($1, $2, $3, $4)',
      ['oauth_pairing_addr', key, 2, 60],
    );
    expect(blocked.rows[0]?.allowed).toBe(false);
    expect(blocked.rows[0]?.retry_after_seconds).toBeGreaterThanOrEqual(1);

    await adminClient.query(`DELETE FROM crove_kernel.mcp_rate_limit`);
    const staleHash = shaHex('stale-sweep');
    await adminClient.query(
      `INSERT INTO crove_kernel.mcp_rate_limit (bucket, key_hash, created_at, expires_at)
       SELECT 'mcp_addr', $1, now() - interval '2 minutes', now() - interval '1 second'
       FROM pg_catalog.generate_series(1, 150)`,
      [staleHash],
    );

    const afterExpiry = await appPool.query<{ allowed: boolean }>(
      'SELECT allowed FROM crove_kernel.mcp_rate_limit_take($1, $2, $3, $4)',
      ['oauth_pairing_addr', key, 2, 60],
    );
    expect(afterExpiry.rows[0]?.allowed).toBe(true);

    const remainingAfterFirst = await adminClient.query<{ n: string }>(
      `SELECT count(*) AS n FROM crove_kernel.mcp_rate_limit WHERE expires_at <= now()`,
    );
    expect(Number(remainingAfterFirst.rows[0]?.n)).toBe(50);

    await appPool.query('SELECT allowed FROM crove_kernel.mcp_rate_limit_take($1, $2, $3, $4)', ['oauth_pairing_addr', key, 2, 60]);
    const remainingAfterSecond = await adminClient.query<{ n: string }>(
      `SELECT count(*) AS n FROM crove_kernel.mcp_rate_limit WHERE expires_at <= now()`,
    );
    expect(Number(remainingAfterSecond.rows[0]?.n)).toBe(0);
  });
});

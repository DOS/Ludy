// SPDX-License-Identifier: AGPL-3.0-only
// Stage 7 (#3972, ADR-0054): pins legacy crove_* role contraction, password invalidation on upgrade, object ACL
// revocation, retired crove.* GUC ignoring, cluster-wide replay safety across databases, indirect membership checks,
// and hardeningViolations fail-closed detection on PostgreSQL 17.
// Self-contained under apps/kernel/test/invariant/ (AGENTS.md Protected paths).
// Set LUDY_TEST_ADMIN_URL (or CROVE_TEST_ADMIN_URL) to a superuser URL; the run creates and drops its own database.
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hardeningViolations, migrate, setRolePasswords } from '@ludy/db/migrate';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const CORE_CUTOVER_MIGRATION = '20270315090000_ludy_kernel_rebrand_core_schemas_roles_gucs.sql';
const CONTRACTION_SUFFIX = '_ludy_kernel_contract_crove_roles_and_gucs.sql';

const CANONICAL_LUDY_ROLES = [
  'ludy_tenant',
  'ludy_app',
  'ludy_worker',
  'ludy_prober',
  'ludy_reporter',
  'ludy_auth_reader',
  'ludy_definer_tenant',
  'ludy_definer_einvoice',
  'ludy_definer_system',
] as const;

const LEGACY_ROLES = [
  'crove_tenant',
  'crove_app',
  'crove_worker',
  'crove_prober',
  'crove_reporter',
  'crove_auth_reader',
  'crove_definer_tenant',
  'crove_definer_einvoice',
  'crove_definer_system',
] as const;

const LEGACY_LOGINS = ['crove_app', 'crove_worker', 'crove_prober', 'crove_reporter'] as const;

const suite = ADMIN ? describe : describe.skip;

function dbUrlFor(baseUrl: string, database: string, user?: string, password?: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${database}`;
  if (user !== undefined) url.username = user;
  if (password !== undefined) url.password = password;
  return url.toString();
}

async function dropRoleCleanly(admin: pg.ClientBase, role: string): Promise<void> {
  const q = pg.escapeIdentifier(role);
  const exists = await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
  if (exists.rowCount === 0) return;
  await admin.query(`GRANT ${q} TO CURRENT_USER WITH INHERIT TRUE, SET TRUE`);
  const made = await admin.query<{ role: string; member: string }>(
    'SELECT g.rolname AS role, m.rolname AS member FROM pg_auth_members am JOIN pg_roles g ON g.oid = am.roleid JOIN pg_roles m ON m.oid = am.member JOIN pg_roles gr ON gr.oid = am.grantor WHERE gr.rolname = $1',
    [role],
  );
  for (const { role: granted, member } of made.rows) {
    await admin.query(`REVOKE ${pg.escapeIdentifier(granted)} FROM ${pg.escapeIdentifier(member)} GRANTED BY ${q} CASCADE`);
  }
  await admin.query(`REVOKE ${q} FROM CURRENT_USER`);
  await admin.query(`DROP OWNED BY ${q}`);
  await admin.query(`DROP ROLE IF EXISTS ${q}`);
}

suite('legacy crove_* role and crove.* GUC contraction (#3972)', () => {
  const dbName = `ludy_test_contract_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const legacyPassword = `legacy-pw-${Date.now()}`;
  let adminUrl = '';
  let preStageDir = '';
  let stage7Dir = '';

  const withAdmin = async <T>(fn: (client: pg.Client) => Promise<T>): Promise<T> => {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  };

  beforeAll(async () => {
    const bootstrap = new pg.Client({ connectionString: ADMIN });
    await bootstrap.connect();
    try {
      await bootstrap.query(`CREATE DATABASE ${dbName}`);
    } finally {
      await bootstrap.end();
    }
    adminUrl = dbUrlFor(ADMIN as string, dbName);

    const files = readdirSync(MIGRATIONS)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    const contractionIndex = files.findIndex((f) => f.endsWith(CONTRACTION_SUFFIX));
    expect(contractionIndex).toBeGreaterThan(0);

    preStageDir = mkdtempSync(join(tmpdir(), 'ludy-pre-contraction-'));
    for (const file of files.slice(0, contractionIndex)) {
      copyFileSync(join(MIGRATIONS, file), join(preStageDir, file));
    }

    stage7Dir = mkdtempSync(join(tmpdir(), 'ludy-stage7-contraction-'));
    for (const file of files.slice(0, contractionIndex + 1)) {
      copyFileSync(join(MIGRATIONS, file), join(stage7Dir, file));
    }

    await migrate({ adminUrl, dir: preStageDir });
    await migrate({ adminUrl, dir: MIGRATIONS });
  }, 180_000);

  afterAll(async () => {
    if (preStageDir) rmSync(preStageDir, { recursive: true, force: true });
    if (stage7Dir) rmSync(stage7Dir, { recursive: true, force: true });
    if (!ADMIN) return;
    const teardown = new pg.Client({ connectionString: ADMIN });
    await teardown.connect();
    try {
      for (const extraDb of [`${dbName}_second`, `${dbName}_noperm`, dbName]) {
        await teardown.query(
          'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
          [extraDb],
        );
        await teardown.query(`DROP DATABASE IF EXISTS ${extraDb}`);
      }
      await dropRoleCleanly(teardown, `${dbName}_limited`);
    } finally {
      await teardown.end();
    }
  });

  it('invalidates upgraded crove_* login passwords, revokes memberships/ACLs, and removes crove.* GUC fallbacks', async () => {
    const contractionFile = readdirSync(MIGRATIONS).find((f) => f.endsWith(CONTRACTION_SUFFIX));
    expect(contractionFile).toBeTruthy();
    const contractionSql = readFileSync(join(MIGRATIONS, contractionFile as string), 'utf8');

    const legacyClient = new pg.Client({ connectionString: dbUrlFor(adminUrl, dbName, 'crove_app', legacyPassword) });
    await expect(legacyClient.connect()).rejects.toMatchObject({ code: '28P01' });
    await legacyClient.end().catch(() => {});

    await expect(setRolePasswords(adminUrl, { crove_app: 'rearmed-pw' })).rejects.toThrow(
      /refusing to set a password on legacy role crove_app after Stage 7 contraction/,
    );

    await withAdmin(async (c) => {
      const { rows: loginStates } = await c.query<{ rolname: string; rolcanlogin: boolean; has_pw: boolean; expired: boolean }>(
        `SELECT rolname,
                rolcanlogin,
                rolpassword IS NOT NULL AS has_pw,
                rolvaliduntil IS NOT NULL AND rolvaliduntil <= '1970-01-01 00:00:00+00'::timestamptz AS expired
         FROM pg_catalog.pg_authid
         WHERE rolname = ANY ($1::text[])
         ORDER BY rolname`,
        [[...LEGACY_LOGINS]],
      );
      expect(loginStates).toEqual([
        { rolname: 'crove_app', rolcanlogin: true, has_pw: false, expired: true },
        { rolname: 'crove_prober', rolcanlogin: true, has_pw: false, expired: true },
        { rolname: 'crove_reporter', rolcanlogin: true, has_pw: false, expired: true },
        { rolname: 'crove_worker', rolcanlogin: true, has_pw: false, expired: true },
      ]);

      // Verify Stage 7 contraction clears password verifiers and sets VALID UNTIL '-infinity' transactionally
      // without mutating cluster roles visible to concurrent sessions on a shared server.
      await c.query('BEGIN');
      try {
        for (const login of LEGACY_LOGINS) {
          await c.query(`ALTER ROLE ${pg.escapeIdentifier(login)} WITH PASSWORD '${legacyPassword}' VALID UNTIL 'infinity'`);
        }
        const { rows: seeded } = await c.query<{ rolname: string; has_pw: boolean }>(
          `SELECT rolname, rolpassword IS NOT NULL AS has_pw
           FROM pg_catalog.pg_authid WHERE rolname = ANY ($1::text[]) ORDER BY rolname`,
          [[...LEGACY_LOGINS]],
        );
        expect(seeded.every((r) => r.has_pw)).toBe(true);
        await c.query(contractionSql);
        const { rows: cleared } = await c.query<{ rolname: string; has_pw: boolean; expired: boolean }>(
          `SELECT rolname,
                  rolpassword IS NOT NULL AS has_pw,
                  rolvaliduntil IS NOT NULL AND rolvaliduntil <= '1970-01-01 00:00:00+00'::timestamptz AS expired
           FROM pg_catalog.pg_authid WHERE rolname = ANY ($1::text[]) ORDER BY rolname`,
          [[...LEGACY_LOGINS]],
        );
        expect(cleared).toEqual([
          { rolname: 'crove_app', has_pw: false, expired: true },
          { rolname: 'crove_prober', has_pw: false, expired: true },
          { rolname: 'crove_reporter', has_pw: false, expired: true },
          { rolname: 'crove_worker', has_pw: false, expired: true },
        ]);
      } finally {
        await c.query('ROLLBACK');
      }

      const { rows: clusterMarker } = await c.query<{ marker: string | null }>(
        `SELECT pg_catalog.shobj_description(oid, 'pg_authid') AS marker
         FROM pg_catalog.pg_roles WHERE rolname = 'crove_tenant'`,
      );
      expect(clusterMarker).toEqual([{ marker: 'ludy:stage7-contracted' }]);

      const { rows: memberships } = await c.query<{ legacy: string; ludy: string }>(
        `SELECT l.rolname AS ludy, c.rolname AS legacy
         FROM pg_catalog.pg_auth_members m
         JOIN pg_catalog.pg_roles l ON l.oid = m.roleid
         JOIN pg_catalog.pg_roles c ON c.oid = m.member
         WHERE c.rolname = ANY ($1::text[]) AND l.rolname = ANY ($2::text[])`,
        [[...LEGACY_ROLES], [...CANONICAL_LUDY_ROLES]],
      );
      expect(memberships).toEqual([]);

      const { rows: leftoverAcls } = await c.query<{ obj: string; grantee: string }>(
        `SELECT obj, gr.rolname AS grantee
         FROM (
           SELECT n.nspname AS obj, a.grantee
           FROM pg_catalog.pg_namespace n
           CROSS JOIN LATERAL pg_catalog.aclexplode(n.nspacl) a
           WHERE n.nspname LIKE 'ludy\\_%'
           UNION ALL
           SELECT pg_catalog.format('%I.%I', n.nspname, cls.relname), a.grantee
           FROM pg_catalog.pg_class cls
           JOIN pg_catalog.pg_namespace n ON n.oid = cls.relnamespace
           CROSS JOIN LATERAL pg_catalog.aclexplode(cls.relacl) a
           WHERE n.nspname LIKE 'ludy\\_%'
           UNION ALL
           SELECT pg_catalog.format('%I.%I.%I', n.nspname, cls.relname, att.attname), a.grantee
           FROM pg_catalog.pg_attribute att
           JOIN pg_catalog.pg_class cls ON cls.oid = att.attrelid
           JOIN pg_catalog.pg_namespace n ON n.oid = cls.relnamespace
           CROSS JOIN LATERAL pg_catalog.aclexplode(att.attacl) a
           WHERE n.nspname LIKE 'ludy\\_%' AND att.attnum > 0 AND NOT att.attisdropped AND att.attacl IS NOT NULL
           UNION ALL
           SELECT p.oid::pg_catalog.regprocedure::text, a.grantee
           FROM pg_catalog.pg_proc p
           JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
           CROSS JOIN LATERAL pg_catalog.aclexplode(p.proacl) a
           WHERE n.nspname LIKE 'ludy\\_%' AND p.proowner <> a.grantee
           UNION ALL
           SELECT pg_catalog.format('%I.%I', n.nspname, t.typname), a.grantee
           FROM pg_catalog.pg_type t
           JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
           CROSS JOIN LATERAL pg_catalog.aclexplode(t.typacl) a
           WHERE n.nspname LIKE 'ludy\\_%' AND t.typacl IS NOT NULL AND t.typowner <> a.grantee
         ) a
         JOIN pg_catalog.pg_roles gr ON gr.oid = a.grantee
         WHERE gr.rolname = ANY ($1::text[])`,
        [[...LEGACY_ROLES]],
      );
      expect(leftoverAcls).toEqual([]);

      await c.query('BEGIN');
      try {
        await c.query('SET LOCAL ROLE crove_prober');
        await expect(c.query('SELECT * FROM ludy_kernel.health()')).rejects.toThrow(/permission denied/);
      } finally {
        await c.query('ROLLBACK');
      }

      await c.query('BEGIN');
      try {
        await c.query('SET LOCAL ROLE crove_app');
        await expect(c.query('SELECT 1 FROM ludy_kernel.tenant')).rejects.toThrow(/permission denied/);
      } finally {
        await c.query('ROLLBACK');
      }

      await c.query('BEGIN');
      try {
        await c.query('SET LOCAL ROLE crove_reporter');
        await expect(c.query('SELECT * FROM ludy_kernel.usage_weekly()')).rejects.toThrow(/permission denied/);
      } finally {
        await c.query('ROLLBACK');
      }

      await c.query('BEGIN');
      try {
        await c.query(`SELECT set_config('crove.ctx', '{"v":1}', true), set_config('crove.ctx_seal', '${'0'.repeat(64)}', true)`);
        const ignored = await c.query<{ v: unknown }>('SELECT ludy_kernel.ctx_verified() AS v');
        expect(ignored.rows).toEqual([{ v: null }]);
        await c.query(`SELECT set_config('ludy.ctx', '{"v":1}', true), set_config('ludy.ctx_seal', '${'0'.repeat(64)}', true)`);
        await expect(c.query('SELECT ludy_kernel.ctx_verified()')).rejects.toMatchObject({ code: '42501', message: 'CONTEXT_SEAL_INVALID' });
      } finally {
        await c.query('ROLLBACK');
      }

      await c.query('BEGIN');
      try {
        await c.query('SELECT pg_catalog.pg_advisory_xact_lock(1129467734, pg_catalog.pg_backend_pid())');
        await c.query(`SELECT set_config('crove.ctx', '{"v":1}', true), set_config('crove.org_id', '00000000-0000-0000-0000-000000000000', true)`);
        await expect(c.query('SELECT ludy_kernel.context_reentry_guard()')).resolves.toBeDefined();
      } finally {
        await c.query('ROLLBACK');
      }

      const { rows: defs } = await c.query<{ fn: string; def: string }>(
        `SELECT f.fn, pg_catalog.pg_get_functiondef(f.fn::pg_catalog.regprocedure) AS def
         FROM pg_catalog.unnest(ARRAY[
           'ludy_kernel.ddl_watch()',
           'ludy_kernel.usage_weekly(integer, boolean, text)',
           'ludy_kernel.member_has_permission(uuid, uuid, text)'
         ]) AS f(fn)`,
      );
      expect(defs).toHaveLength(3);
      for (const row of defs) {
        if (row.fn === 'ludy_kernel.ddl_watch()') {
          expect(row.def).not.toMatch(/crove[_.]|crove\\_/i);
        } else if (row.fn === 'ludy_kernel.usage_weekly(integer, boolean, text)') {
          expect(row.def).not.toContain('crove_reporter');
        } else {
          expect(row.def).not.toContain('crove_tenant');
        }
      }
    });
  });

  it('fails hardeningViolations closed when a legacy role regains direct ludy_* membership after contraction', async () => {
    await withAdmin(async (c) => {
      await c.query('BEGIN');
      try {
        await c.query('GRANT ludy_app TO crove_app');
        const violations = await hardeningViolations(c);
        expect(violations.some((v) => /legacy role crove_app still holds membership in ludy_app .* REVOKE "ludy_app" FROM "crove_app" GRANTED BY/.test(v))).toBe(true);
      } finally {
        await c.query('ROLLBACK');
      }
      expect(await hardeningViolations(c)).toEqual([]);
    });
  });

  it('fails hardeningViolations closed when a legacy role reaches ludy_* indirectly via an intermediate role', async () => {
    const midRole = `${dbName}_mid`;
    await withAdmin(async (c) => {
      await c.query('BEGIN');
      try {
        await c.query(`CREATE ROLE ${midRole} NOLOGIN; GRANT ludy_app TO ${midRole}; GRANT ${midRole} TO crove_app`);
        const violations = await hardeningViolations(c);
        expect(
          violations.some((v) =>
            new RegExp(`legacy role crove_app still holds indirect membership in ludy_app via ${midRole} .*REVOKE "${midRole}" FROM "crove_app"`).test(v),
          ),
        ).toBe(true);
      } finally {
        await c.query('ROLLBACK');
      }
      expect(await hardeningViolations(c)).toEqual([]);
    });
  });

  it('flags direct privileges granted to legacy crove_* roles in both owned and shared-database modes after Stage 7 contraction', async () => {
    await withAdmin(async (c) => {
      await c.query('BEGIN');
      try {
        await c.query(
          'GRANT USAGE ON SCHEMA ludy_kernel TO crove_prober; ' +
            'GRANT EXECUTE ON FUNCTION ludy_kernel.health(integer) TO crove_prober; ' +
            'GRANT SELECT (org_id) ON ludy_kernel.tenant TO crove_app; ' +
            'GRANT USAGE ON TYPE ludy_finance.amount TO crove_tenant',
        );
        const ownedViolations = await hardeningViolations(c);
        expect(ownedViolations.some((v) => /legacy role crove_prober still holds direct schema privileges in ludy_kernel/.test(v))).toBe(true);
        expect(ownedViolations.some((v) => /legacy role crove_prober still holds direct routine privileges in ludy_kernel/.test(v))).toBe(true);
        expect(ownedViolations.some((v) => /legacy role crove_app still holds direct column privileges in ludy_kernel/.test(v))).toBe(true);
        expect(ownedViolations.some((v) => /legacy role crove_tenant still holds direct type privileges in ludy_finance/.test(v))).toBe(true);
      } finally {
        await c.query('ROLLBACK');
      }
      expect(await hardeningViolations(c)).toEqual([]);

      const baseline = await hardeningViolations(c, { shared: true });
      expect(baseline.some((v) => /role crove_prober holds privileges on objects of the Ludy schema ludy_kernel/.test(v))).toBe(false);
      await c.query('BEGIN');
      try {
        await c.query('GRANT USAGE ON SCHEMA ludy_kernel TO crove_prober; GRANT EXECUTE ON FUNCTION ludy_kernel.health(integer) TO crove_prober');
        const violations = await hardeningViolations(c, { shared: true });
        expect(violations.some((v) => /role crove_prober holds privileges on objects of the Ludy schema ludy_kernel/.test(v))).toBe(true);
      } finally {
        await c.query('ROLLBACK');
      }
      expect(await hardeningViolations(c, { shared: true })).toEqual(baseline);
    });
  });

  it('flags password/marker drift, default privileges, and legacy crove_* ownership of ludy_* objects after Stage 7 contraction', async () => {
    const contractionFile = readdirSync(MIGRATIONS).find((f) => f.endsWith(CONTRACTION_SUFFIX));
    expect(contractionFile).toBeTruthy();
    const contractionSql = readFileSync(join(MIGRATIONS, contractionFile as string), 'utf8');

    await withAdmin(async (c) => {
      await c.query('BEGIN');
      try {
        await c.query("ALTER ROLE crove_app VALID UNTIL 'infinity'");
        for (const shared of [false, true]) {
          const violations = await hardeningViolations(c, shared ? { shared: true } : undefined);
          expect(
            violations.some((v) => /legacy login role crove_app does not have an expired VALID UNTIL after Stage 7 contraction/.test(v)),
          ).toBe(true);
        }
      } finally {
        await c.query('ROLLBACK');
      }
      expect(await hardeningViolations(c)).toEqual([]);

      await c.query('BEGIN');
      try {
        await c.query("ALTER ROLE crove_app PASSWORD 'stale-legacy-pw'");
        for (const shared of [false, true]) {
          const violations = await hardeningViolations(c, shared ? { shared: true } : undefined);
          expect(
            violations.some((v) => /legacy login role crove_app still has a password verifier in pg_authid after Stage 7 contraction/.test(v)),
          ).toBe(true);
        }
      } finally {
        await c.query('ROLLBACK');
      }
      expect(await hardeningViolations(c)).toEqual([]);

      await c.query('BEGIN');
      try {
        await c.query('COMMENT ON ROLE crove_tenant IS NULL');
        for (const shared of [false, true]) {
          const violations = await hardeningViolations(c, shared ? { shared: true } : undefined);
          expect(
            violations.some((v) => /cluster Stage 7 contraction marker is missing from crove_tenant/.test(v)),
          ).toBe(true);
        }
      } finally {
        await c.query('ROLLBACK');
      }
      expect(await hardeningViolations(c)).toEqual([]);

      const defAclRole = `${dbName}_defacl`;
      await c.query('BEGIN');
      try {
        await c.query(
          `CREATE ROLE ${defAclRole} NOLOGIN; ` +
            `CREATE ROLE ${defAclRole}_nonmember LOGIN NOSUPERUSER; ` +
            `ALTER DEFAULT PRIVILEGES FOR ROLE ${defAclRole} IN SCHEMA ludy_jobs GRANT SELECT ON TABLES TO crove_worker; ` +
            `ALTER DEFAULT PRIVILEGES FOR ROLE ${defAclRole} GRANT SELECT ON TABLES TO crove_worker`,
        );
        const ownedDefViolations = await hardeningViolations(c);
        expect(
          ownedDefViolations.some((v) =>
            new RegExp(`legacy role crove_worker still holds default privileges on tables in ludy_jobs for role ${defAclRole}`).test(v),
          ),
        ).toBe(true);
        expect(
          ownedDefViolations.some((v) =>
            new RegExp(`legacy role crove_worker still holds default privileges on tables in all schemas for role ${defAclRole}`).test(v),
          ),
        ).toBe(true);

        const sharedDefViolations = await hardeningViolations(c, { shared: true });
        expect(
          sharedDefViolations.some((v) =>
            new RegExp(`legacy role crove_worker still holds default privileges on tables in ludy_jobs for role ${defAclRole}`).test(v),
          ),
        ).toBe(true);
        expect(
          sharedDefViolations.some((v) =>
            new RegExp(`legacy role crove_worker still holds default privileges on tables in all schemas for role ${defAclRole}`).test(v),
          ),
        ).toBe(false);

        await c.query(`GRANT USAGE ON SCHEMA ludy_meta TO ${defAclRole}_nonmember; GRANT SELECT ON ludy_meta.deployment TO ${defAclRole}_nonmember`);
        await c.query('SAVEPOINT sp_defacl_denied');
        await c.query(`SET LOCAL ROLE ${defAclRole}_nonmember`);
        await expect(c.query(contractionSql)).rejects.toThrow(/default privileges still grant to legacy crove_\* roles/);
        await c.query('ROLLBACK TO SAVEPOINT sp_defacl_denied');
        await c.query(contractionSql);
        expect((await hardeningViolations(c)).some((v) => /still holds default privileges/.test(v))).toBe(false);
      } finally {
        await c.query('ROLLBACK');
      }
      expect(await hardeningViolations(c)).toEqual([]);

      const ownedSchema = 'ludy_t3972_owned';
      await c.query('BEGIN');
      try {
        await c.query(
          `CREATE SCHEMA ${ownedSchema} AUTHORIZATION crove_definer_tenant; ` +
            `CREATE TABLE ${ownedSchema}.legacy_tbl (id integer); ` +
            `ALTER TABLE ${ownedSchema}.legacy_tbl OWNER TO crove_definer_tenant; ` +
            `CREATE SEQUENCE ${ownedSchema}.legacy_seq; ` +
            `ALTER SEQUENCE ${ownedSchema}.legacy_seq OWNER TO crove_definer_tenant; ` +
            `CREATE FUNCTION ${ownedSchema}.legacy_fn() RETURNS integer LANGUAGE sql SET search_path = pg_catalog, pg_temp AS $$ SELECT 1 $$; ` +
            `ALTER FUNCTION ${ownedSchema}.legacy_fn() OWNER TO crove_definer_tenant; ` +
            `CREATE TYPE ${ownedSchema}.legacy_enum AS ENUM ('a'); ` +
            `ALTER TYPE ${ownedSchema}.legacy_enum OWNER TO crove_definer_tenant`,
        );
        for (const shared of [false, true]) {
          const violations = await hardeningViolations(c, shared ? { shared: true } : undefined);
          for (const kind of ['schema', 'relation', 'sequence', 'routine', 'type']) {
            expect(
              violations.some((v) => new RegExp(`legacy role crove_definer_tenant still owns ${kind} .* in ${ownedSchema}`).test(v)),
            ).toBe(true);
          }
        }
        await c.query('SAVEPOINT sp_owned');
        await expect(c.query(contractionSql)).rejects.toThrow(/legacy crove_\* role still owns ludy_\* objects/);
        await c.query('ROLLBACK TO SAVEPOINT sp_owned');
      } finally {
        await c.query('ROLLBACK');
      }
      expect(await hardeningViolations(c)).toEqual([]);
    });
  });

  it('never commits cluster-wide transitional crove_* -> ludy_* grants when migrating a second DB stops midway', async () => {
    const secondDb = `${dbName}_second`;
    const dbBUrl = dbUrlFor(ADMIN as string, secondDb);
    const files = readdirSync(MIGRATIONS)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    const coreCutoverIdx = files.indexOf(CORE_CUTOVER_MIGRATION);
    expect(coreCutoverIdx).toBeGreaterThan(0);

    const abortDir = mkdtempSync(join(tmpdir(), 'ludy-abort-replay-'));
    for (const file of files.slice(0, coreCutoverIdx + 1)) {
      copyFileSync(join(MIGRATIONS, file), join(abortDir, file));
    }
    writeFileSync(
      join(abortDir, '20270315090100_ludy_kernel_abort_probe.sql'),
      "DO $$ BEGIN RAISE EXCEPTION 'SIMULATED_MID_UPGRADE_ABORT'; END $$;\n",
    );

    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    try {
      await root.query(`CREATE DATABASE ${secondDb}`);
    } finally {
      await root.end();
    }

    try {
      await expect(migrate({ adminUrl: dbBUrl, dir: abortDir })).rejects.toThrow(/SIMULATED_MID_UPGRADE_ABORT/);

      await withAdmin(async (c) => {
        const { rows: direct } = await c.query(
          `SELECT 1 FROM pg_catalog.pg_auth_members am
           JOIN pg_catalog.pg_roles tgt ON tgt.oid = am.roleid
           JOIN pg_catalog.pg_roles mem ON mem.oid = am.member
           WHERE mem.rolname = ANY ($1::text[]) AND tgt.rolname = ANY ($2::text[])`,
          [[...LEGACY_ROLES], [...CANONICAL_LUDY_ROLES]],
        );
        expect(direct).toEqual([]);

        const { rows: effective } = await c.query(
          `SELECT mem.rolname, tgt.rolname FROM pg_catalog.pg_roles mem CROSS JOIN pg_catalog.pg_roles tgt
           WHERE mem.rolname = ANY ($1::text[]) AND tgt.rolname = ANY ($2::text[])
             AND (pg_catalog.pg_has_role(mem.oid, tgt.oid, 'MEMBER')
                  OR pg_catalog.pg_has_role(mem.oid, tgt.oid, 'USAGE')
                  OR pg_catalog.pg_has_role(mem.oid, tgt.oid, 'SET'))`,
          [[...LEGACY_ROLES], [...CANONICAL_LUDY_ROLES]],
        );
        expect(effective).toEqual([]);
        expect(await hardeningViolations(c)).toEqual([]);
      });

      await migrate({ adminUrl: dbBUrl, dir: MIGRATIONS });
      const bClient = new pg.Client({ connectionString: dbBUrl });
      await bClient.connect();
      try {
        expect(await hardeningViolations(bClient)).toEqual([]);
      } finally {
        await bClient.end();
      }
    } finally {
      rmSync(abortDir, { recursive: true, force: true });
      const teardown = new pg.Client({ connectionString: ADMIN });
      await teardown.connect();
      try {
        await teardown.query(
          'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
          [secondDb],
        );
        await teardown.query(`DROP DATABASE IF EXISTS ${secondDb}`);
      } finally {
        await teardown.end();
      }
    }
  }, 180_000);

  it('fails Stage 7 loudly without mutating cluster roles when a non-superuser runner lacks ADMIN OPTION on crove_reporter, and passes once contracted', async () => {
    const nopermDb = `${dbName}_noperm`;
    const limitedRunner = `${dbName}_limited`;
    const limitedPassword = `limited-pw-${Date.now()}`;
    const limitedUrl = dbUrlFor(ADMIN as string, nopermDb, limitedRunner, limitedPassword);
    const contractionFile = readdirSync(MIGRATIONS).find((f) => f.endsWith(CONTRACTION_SUFFIX));
    expect(contractionFile).toBeTruthy();
    const contractionSql = readFileSync(join(MIGRATIONS, contractionFile as string), 'utf8');

    const admin = new pg.Client({ connectionString: ADMIN });
    await admin.connect();
    try {
      await dropRoleCleanly(admin, limitedRunner);
      await admin.query(`CREATE ROLE ${limitedRunner} LOGIN CREATEROLE NOSUPERUSER NOBYPASSRLS PASSWORD '${limitedPassword}'`);
      for (const role of [...CANONICAL_LUDY_ROLES, ...LEGACY_ROLES]) {
        if (role === 'crove_reporter') continue;
        const exists = await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
        if (exists.rowCount && exists.rowCount > 0) {
          await admin.query(`GRANT ${pg.escapeIdentifier(role)} TO ${limitedRunner} WITH ADMIN TRUE, INHERIT FALSE, SET FALSE`);
        }
      }
      await admin.query(`CREATE DATABASE ${nopermDb} OWNER ${limitedRunner}`);

      await migrate({ adminUrl: limitedUrl, dir: preStageDir });

      const checkDb = new pg.Client({ connectionString: dbUrlFor(ADMIN as string, nopermDb) });
      await checkDb.connect();
      try {
        await checkDb.query('BEGIN');
        try {
          await checkDb.query("ALTER ROLE crove_reporter WITH PASSWORD NULL VALID UNTIL 'infinity'");
          await checkDb.query('SAVEPOINT sp_no_admin');
          await checkDb.query(`SET LOCAL ROLE ${pg.escapeIdentifier(limitedRunner)}`);
          await expect(checkDb.query(contractionSql)).rejects.toThrow(
            /stage 7 contraction failed: role .* cannot clear or verify cleared password on crove_reporter/,
          );
          await checkDb.query('ROLLBACK TO SAVEPOINT sp_no_admin');

          await checkDb.query("ALTER ROLE crove_reporter WITH PASSWORD NULL VALID UNTIL '-infinity'");
          await checkDb.query('COMMENT ON ROLE crove_tenant IS NULL');
          await checkDb.query('SAVEPOINT sp_no_marker');
          await checkDb.query(`SET LOCAL ROLE ${pg.escapeIdentifier(limitedRunner)}`);
          await expect(checkDb.query(contractionSql)).rejects.toThrow(
            /stage 7 contraction failed: role .* cannot clear or verify cleared password on crove_reporter/,
          );
          await checkDb.query('ROLLBACK TO SAVEPOINT sp_no_marker');

          // Non-superuser without SELECT on pg_authid still clears passwords for legacy roles where it holds ADMIN OPTION.
          await checkDb.query('COMMENT ON ROLE crove_tenant IS \'ludy:stage7-contracted\'');
          await checkDb.query("ALTER ROLE crove_app WITH PASSWORD 'rearmed-pw' VALID UNTIL '-infinity'");
          await checkDb.query('SAVEPOINT sp_nonsuper_clear');
          await checkDb.query(`SET LOCAL ROLE ${pg.escapeIdentifier(limitedRunner)}`);
          await checkDb.query(contractionSql);
          await checkDb.query('RESET ROLE');
          const { rows: appState } = await checkDb.query<{ has_pw: boolean; expired: boolean }>(
            `SELECT rolpassword IS NOT NULL AS has_pw,
                    rolvaliduntil IS NOT NULL AND rolvaliduntil <= '1970-01-01 00:00:00+00'::timestamptz AS expired
             FROM pg_catalog.pg_authid WHERE rolname = 'crove_app'`,
          );
          expect(appState).toEqual([{ has_pw: false, expired: true }]);
          await checkDb.query('ROLLBACK TO SAVEPOINT sp_nonsuper_clear');
        } finally {
          await checkDb.query('ROLLBACK');
        }

        const { rows } = await checkDb.query<{ count: string }>(
          'SELECT count(*)::text AS count FROM ludy_meta.schema_migrations WHERE name LIKE $1',
          [`%${CONTRACTION_SUFFIX.replaceAll('_', '\\_')}`],
        );
        expect(rows).toEqual([{ count: '0' }]);

        await expect(migrate({ adminUrl: limitedUrl, dir: stage7Dir })).resolves.toEqual([contractionFile as string]);
        const limitedClient = new pg.Client({ connectionString: limitedUrl });
        await limitedClient.connect();
        try {
          expect(await hardeningViolations(limitedClient)).toEqual([]);
        } finally {
          await limitedClient.end();
        }
      } finally {
        await checkDb.end();
      }
    } finally {
      await admin.query(
        'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
        [nopermDb],
      ).catch(() => {});
      await admin.query(`DROP DATABASE IF EXISTS ${nopermDb}`).catch(() => {});
      await dropRoleCleanly(admin, limitedRunner).catch(() => {});
      await admin.end();
    }
  }, 180_000);
});

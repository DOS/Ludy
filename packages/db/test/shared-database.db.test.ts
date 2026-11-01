// SPDX-License-Identifier: AGPL-3.0-only
// The shared-database mode (#2284) on the Supabase Postgres image: Ludy migrated into a database that another system owns a
// schema, a role and default privileges in (Ludy Cloud inside DOS's Supabase project). Every effect must stay with Ludy's own
// roles and schemas: the other system's roles keep TEMPORARY, its schema, ACLs and roles are left as they were, its DDL
// raises no alert, and none of its roles can reach what Ludy built.
//
// Set CROVE_TEST_SUPABASE_URL to the `postgres` role on a throwaway supabase/postgres container (as for supabase.db.test.ts).
// The test makes, uses and drops its own database in that container, and refuses any host but this machine.
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/index.ts';
import { applyAuthGrants, hardeningViolations, installDdlWatch, migrate, readMigrations, readSharedVariants, setRolePasswords } from '../src/migrate.ts';

const URL_ENV = process.env.CROVE_TEST_SUPABASE_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const REVOKE_TEMP = '20261015120000_crove_kernel_revoke_temp.sql';
const DB = 'ludy_shared_test';
const VARIANTS = fileURLToPath(new URL('../../../supabase/shared-variants', import.meta.url));
// The CI job sets CROVE_REQUIRE_SUPABASE_TEST, so losing the URL there fails the job instead of skipping the suite.
if (process.env.CROVE_REQUIRE_SUPABASE_TEST && !URL_ENV) {
  throw new Error('CROVE_REQUIRE_SUPABASE_TEST is set but CROVE_TEST_SUPABASE_URL is not');
}
const suite = URL_ENV ? describe : describe.skip;

function as(url: string, user: string, password: string, database: string): string {
  const u = new URL(url);
  u.username = user;
  u.password = password;
  u.pathname = `/${database}`;
  return u.toString();
}

suite('shared-database mode beside a foreign schema and role (Supabase Postgres image)', () => {
  // The suite body also runs when it is skipped (vitest collects it), so the URLs below must build without CROVE_TEST_SUPABASE_URL:
  // a placeholder stands in, and no hook or test runs against it.
  const adminUrl = URL_ENV ?? 'postgres://postgres:unused@127.0.0.1:1/postgres';
  const sharedUrl = as(adminUrl, decodeURIComponent(new URL(adminUrl).username), decodeURIComponent(new URL(adminUrl).password), DB);
  const FOREIGN_PASSWORD = 'foreign-test-password-1';
  let admin: pg.Client;
  let client: pg.Client;
  const logs: string[] = [];
  let before: Snapshot;

  // What of the other system's must not change: its schema's ACLs, its roles' attributes and memberships, the database ACL.
  type Snapshot = { acls: unknown[]; roles: unknown[]; members: unknown[]; datacl: unknown };
  const snapshot = async (): Promise<Snapshot> => {
    const acls = await client.query(
      `SELECT c.relname AS name, c.relacl::text AS acl FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'dos_core'
       UNION ALL SELECT p.proname, p.proacl::text FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'dos_core'
       UNION ALL SELECT 'schema', n.nspacl::text FROM pg_namespace n WHERE n.nspname = 'dos_core' ORDER BY 1, 2`,
    );
    const roles = await client.query(
      `SELECT rolname, rolsuper, rolcreaterole, rolcreatedb, rolcanlogin, rolinherit, rolbypassrls, rolconfig::text AS config, rolvaliduntil::text AS until
       FROM pg_roles WHERE rolname NOT LIKE 'crove\\_%' ORDER BY 1`,
    );
    const members = await client.query(
      `SELECT r.rolname AS role, m.rolname AS member, am.admin_option FROM pg_auth_members am JOIN pg_roles r ON r.oid = am.roleid JOIN pg_roles m ON m.oid = am.member
       WHERE r.rolname NOT LIKE 'crove\\_%' AND m.rolname NOT LIKE 'crove\\_%' ORDER BY 1, 2`,
    );
    const datacl = await client.query('SELECT datacl::text AS acl FROM pg_database WHERE datname = current_database()');
    return { acls: acls.rows, roles: roles.rows, members: members.rows, datacl: datacl.rows };
  };
  const migrateShared = (extra: { allowModeSwitch?: boolean } = {}) => migrate({ adminUrl: sharedUrl, dir: MIGRATIONS, sharedDatabase: true, log: (m) => logs.push(m), ...extra });
  const withRole = async <T>(user: string, run: (c: pg.Client) => Promise<T>): Promise<T> => {
    const c = new pg.Client({ connectionString: as(adminUrl, user, FOREIGN_PASSWORD, DB) });
    await c.connect();
    try {
      return await run(c);
    } finally {
      await c.end();
    }
  };
  const ddlEvents = async () => (await client.query<{ session_role: string; command_tag: string; object_identity: string | null }>(
    'SELECT session_role, command_tag, object_identity FROM crove_kernel.ddl_event ORDER BY id',
  )).rows;

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: adminUrl });
    if (!['127.0.0.1', 'localhost', '::1'].includes(admin.host)) throw new Error(`CROVE_TEST_SUPABASE_URL must point at a throwaway local container, not ${admin.host}`);
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${DB}`);
    for (const role of ['dos_app', 'dos_reader', 'crove_lookalike']) await admin.query(`DROP ROLE IF EXISTS ${role}`);
    await admin.query(`CREATE ROLE dos_app LOGIN PASSWORD '${FOREIGN_PASSWORD}'`);
    await admin.query(`CREATE ROLE dos_reader LOGIN PASSWORD '${FOREIGN_PASSWORD}'`);
    // A role of the other system that only looks like one of Ludy's: it is not trusted as one.
    await admin.query(`CREATE ROLE crove_lookalike LOGIN PASSWORD '${FOREIGN_PASSWORD}'`);
    client = new pg.Client({ connectionString: sharedUrl });
    await client.connect();
    // The other system's schema, a definer function that pins no search_path, a table with data, and the default
    // privileges Supabase sets (global, for objects the migration role creates), which reach any schema it creates.
    await client.query(`
      CREATE SCHEMA dos_core;
      GRANT USAGE, CREATE ON SCHEMA dos_core TO dos_app, crove_lookalike;
      CREATE TABLE dos_core.accounts (id int PRIMARY KEY, email text);
      INSERT INTO dos_core.accounts VALUES (1, 'someone@example.com');
      GRANT SELECT ON dos_core.accounts TO dos_reader;
      CREATE FUNCTION dos_core.touch() RETURNS int LANGUAGE sql SECURITY DEFINER AS $$ SELECT 1 $$;
      ALTER DEFAULT PRIVILEGES FOR ROLE postgres GRANT SELECT ON TABLES TO dos_reader;
      ALTER DEFAULT PRIVILEGES FOR ROLE postgres GRANT EXECUTE ON FUNCTIONS TO dos_reader;
      ALTER DEFAULT PRIVILEGES FOR ROLE postgres GRANT USAGE ON SEQUENCES TO dos_reader;`);
    before = await snapshot();
  }, 60_000);

  afterAll(async () => {
    await client?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => {});
    for (const role of ['dos_app', 'dos_reader', 'crove_lookalike']) await admin?.query(`DROP ROLE IF EXISTS ${role}`).catch(() => {});
    await admin?.query('ALTER ROLE crove_prober PASSWORD NULL').catch(() => {});
    await admin?.end();
  });

  it('applies every migration, the shared variant in place of the TEMPORARY revoke, and records the hash of the variant in the ledger', async () => {
    const files = await readMigrations(MIGRATIONS);
    expect(await migrateShared()).toEqual(files.map((f) => f.name));
    expect(logs).toContain(`applying ${REVOKE_TEMP} (shared-database variant)`);
    expect(await migrateShared()).toEqual([]);
    const variant = (await readSharedVariants(VARIANTS, files)).get(REVOKE_TEMP);
    const original = files.find((f) => f.name === REVOKE_TEMP);
    const row = await client.query('SELECT sha256 FROM crove_meta.schema_migrations WHERE name = $1', [REVOKE_TEMP]);
    // The variant's own hash is in the ledger, not the original's, so a shared database shows what ran.
    expect(row.rows[0]?.sha256).toBe(variant?.sha256);
    expect(variant?.sha256).not.toBe(original?.sha256);
    expect((await client.query("SELECT value FROM crove_meta.deployment WHERE key = 'shared_database'")).rows).toEqual([{ value: 'true' }]);
  }, 180_000);

  it('leaves TEMPORARY with PUBLIC: the other system keeps it, and so do its new roles', async () => {
    const db = await client.query<{ grantee: string }>(
      `SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END AS grantee
       FROM pg_database d, LATERAL aclexplode(COALESCE(d.datacl, acldefault('d', d.datdba))) a
       WHERE d.datname = current_database() AND a.privilege_type = 'TEMPORARY'`,
    );
    expect(db.rows.map((r) => r.grantee)).toContain('PUBLIC');
    const { rows } = await client.query(`SELECT has_database_privilege('dos_reader', current_database(), 'TEMPORARY') AS reader, has_database_privilege('dos_app', current_database(), 'TEMPORARY') AS app`);
    expect(rows).toEqual([{ reader: true, app: true }]);
    await client.query('CREATE ROLE dos_new_role LOGIN');
    try {
      expect((await client.query("SELECT has_database_privilege('dos_new_role', current_database(), 'TEMPORARY') AS temp")).rows).toEqual([{ temp: true }]);
    } finally {
      await client.query('DROP ROLE dos_new_role');
    }
  });

  it('passes the shared guard, while the default guard still reports the TEMPORARY rule (it is not vacuous)', async () => {
    expect(await hardeningViolations(client, { shared: true })).toEqual([]);
    const owned = await hardeningViolations(client);
    expect(owned.length).toBeGreaterThan(0);
    expect(owned.every((v) => v.includes('can create temporary objects'))).toBe(true);
  });

  it('leaves the other system as it was: its schema, ACLs, roles, memberships and the database ACL', async () => {
    expect(await snapshot()).toEqual(before);
    expect((await client.query('SELECT email FROM dos_core.accounts')).rows).toEqual([{ email: 'someone@example.com' }]);
  });

  it('lets no foreign role reach what Ludy built, although the other system grants every new object of the migration role', async () => {
    // The precondition: the default privileges do reach a new object of this role in a Ludy schema.
    await client.query('CREATE TABLE crove_kernel.t2284_probe (i int)');
    try {
      expect((await client.query("SELECT has_table_privilege('dos_reader', 'crove_kernel.t2284_probe', 'SELECT') AS reach")).rows).toEqual([{ reach: true }]);
      expect((await hardeningViolations(client, { shared: true })).join('\n')).toMatch(/role dos_reader holds privileges on objects of the Ludy schema crove_kernel/);
      await migrateShared();
      expect(logs.some((l) => l.includes("took back dos_reader's privileges"))).toBe(true);
    } finally {
      await client.query('DROP TABLE crove_kernel.t2284_probe');
    }
    expect(await hardeningViolations(client, { shared: true })).toEqual([]);
    const reach = await client.query(
      `SELECT r.rolname,
              bool_or(has_table_privilege(r.oid, c.oid, 'SELECT,INSERT,UPDATE,DELETE')) AS tables,
              bool_or(has_schema_privilege(r.oid, n.oid, 'USAGE')) AS schemas,
              bool_or(has_function_privilege(r.oid, p.oid, 'EXECUTE')) AS functions
       FROM pg_roles r
       CROSS JOIN pg_namespace n
       LEFT JOIN pg_class c ON c.relnamespace = n.oid AND c.relkind IN ('r', 'p', 'v')
       LEFT JOIN pg_proc p ON p.pronamespace = n.oid
       WHERE r.rolname IN ('dos_reader', 'dos_app', 'anon', 'authenticated', 'service_role') AND n.nspname IN ('crove_kernel', 'crove_finance', 'crove_social', 'crove_crm', 'crove_notes', 'crove_ads')
       GROUP BY r.rolname ORDER BY 1`,
    );
    for (const row of reach.rows) expect(row, row.rolname).toMatchObject({ tables: false, schemas: false, functions: false });
    expect(reach.rows.map((r) => r.rolname)).toContain('dos_reader');
  }, 180_000);

  it('records DDL that concerns Ludy and ignores the other system\'s, and the other way round in the owned mode', async () => {
    const result = await installDdlWatch({ adminUrl: sharedUrl, log: (m) => logs.push(m) });
    // On this image `postgres` may create event triggers (supautils' privileged role), as on a hosted project.
    expect(result).toBe('installed');
    await client.query('DELETE FROM crove_kernel.ddl_event');
    // The other system's roles and the migration role in the other system's schema: no row.
    await withRole('dos_app', async (c) => {
      await c.query('CREATE TABLE dos_core.t1 (i int)');
      await c.query('ALTER TABLE dos_core.t1 ADD COLUMN j int');
      await c.query('DROP TABLE dos_core.t1');
    });
    await client.query('CREATE TABLE dos_core.t2 (i int)');
    await client.query('GRANT SELECT ON dos_core.t2 TO dos_reader');
    await client.query('DROP TABLE dos_core.t2');
    expect(await ddlEvents()).toEqual([]);
    // A foreign role that touches a Ludy schema, and a Ludy-named role anywhere, are recorded.
    await client.query('GRANT USAGE, CREATE ON SCHEMA crove_kernel TO dos_app');
    await client.query('DELETE FROM crove_kernel.ddl_event');
    await withRole('dos_app', async (c) => {
      await c.query('CREATE TABLE crove_kernel.foreign_probe (i int)');
      await c.query('DROP TABLE crove_kernel.foreign_probe');
    });
    await client.query('REVOKE ALL ON SCHEMA crove_kernel FROM dos_app');
    // One of Ludy's own roles, by name, is recorded wherever it works; a look-alike role of the other system is not.
    await admin.query(`ALTER ROLE crove_prober PASSWORD '${FOREIGN_PASSWORD}'`);
    await client.query('GRANT USAGE, CREATE ON SCHEMA dos_core TO crove_prober');
    await withRole('crove_prober', (c) => c.query('CREATE TABLE dos_core.ludy_probe (i int)'));
    await withRole('crove_lookalike', (c) => c.query('CREATE TABLE dos_core.lookalike_probe (i int)'));
    await client.query('DROP TABLE dos_core.ludy_probe');
    await client.query('DROP TABLE dos_core.lookalike_probe');
    await client.query('REVOKE ALL ON SCHEMA dos_core FROM crove_prober');
    const recorded = await ddlEvents();
    expect(recorded).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ session_role: 'dos_app', command_tag: 'CREATE TABLE', object_identity: 'crove_kernel.foreign_probe' }),
        expect.objectContaining({ session_role: 'crove_prober', command_tag: 'CREATE TABLE', object_identity: 'dos_core.ludy_probe' }),
      ]),
    );
    expect(recorded.some((e) => e.object_identity === 'dos_core.lookalike_probe')).toBe(false);
    expect(recorded.every((e) => (e.object_identity ?? '').startsWith('crove_') || e.session_role === 'crove_prober' || e.session_role === 'postgres')).toBe(true);
    // The owned mode records the other system's DDL, as before (the flag is what differs).
    await client.query("UPDATE crove_meta.deployment SET value = 'false' WHERE key = 'shared_database'");
    try {
      await client.query('DELETE FROM crove_kernel.ddl_event');
      await withRole('dos_app', (c) => c.query('CREATE TABLE dos_core.owned_probe (i int)'));
      await client.query('DROP TABLE dos_core.owned_probe');
      expect((await ddlEvents()).some((e) => e.session_role === 'dos_app' && e.object_identity === 'dos_core.owned_probe')).toBe(true);
    } finally {
      await client.query("UPDATE crove_meta.deployment SET value = 'true' WHERE key = 'shared_database'");
    }
    // A database whose runner never wrote the mode (no table) behaves as an owned one, and a statement never fails for it.
    await client.query('DROP TABLE crove_meta.deployment');
    await client.query('DELETE FROM crove_kernel.ddl_event');
    await withRole('dos_app', (c) => c.query('CREATE TABLE dos_core.no_mode_probe (i int)'));
    await client.query('DROP TABLE dos_core.no_mode_probe');
    expect((await ddlEvents()).some((e) => e.object_identity === 'dos_core.no_mode_probe')).toBe(true);
    // A database with a ledger and no recorded mode is an owned one: the run refuses to call it shared without the switch.
    await expect(migrateShared()).rejects.toThrow(/migrated in owned-database mode/);
    await migrateShared({ allowModeSwitch: true });
    expect((await client.query('SELECT value FROM crove_meta.deployment')).rows).toEqual([{ value: 'true' }]);
    // The pipeline's own runs leave no row either way.
    await client.query('DELETE FROM crove_kernel.ddl_event');
    await migrateShared();
    expect(await ddlEvents()).toEqual([]);
  }, 180_000);

  it('never sets a password on a role that is not Ludy\'s, and refuses auth-grants', async () => {
    await expect(setRolePasswords(sharedUrl, { supabase_auth_admin: 'x'.repeat(24) }, { sharedDatabase: true })).rejects.toThrow(/not a Ludy role/);
    await expect(applyAuthGrants({ adminUrl: sharedUrl, sharedDatabase: true, timeoutMs: 1 })).rejects.toThrow(/not available in a shared database/);
    expect(await snapshot()).toEqual(before);
  });

  it('keeps a Ludy-owned migration idempotent and the other system\'s default privileges untouched', async () => {
    const { rows } = await client.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM pg_default_acl d JOIN pg_roles r ON r.oid = d.defaclrole WHERE r.rolname = 'postgres' AND d.defaclnamespace = 0",
    );
    expect(Number(rows[0]?.n)).toBeGreaterThan(0);
    expect(await migrateShared()).toEqual([]);
  });
  // A login that ran the bootstrap is the grantor of the memberships it made (crove_tenant to crove_app and the others); they
  // go before the role can. The admin takes its privileges for that.
  const dropLogin = async (role: string): Promise<void> => {
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
    await admin.query(`DROP ROLE ${q}`);
  };

  it('locks the mode to the database: a run that asks for the other mode is refused unless a switch is set, both ways', async () => {
    await expect(migrate({ adminUrl: sharedUrl, dir: MIGRATIONS, sharedDatabase: false })).rejects.toThrow(/migrated in shared-database mode and CROVE_SHARED_DATABASE asks for owned/);
    expect((await client.query("SELECT value FROM crove_meta.deployment WHERE key = 'shared_database'")).rows).toEqual([{ value: 'true' }]);
    // The switch is explicit; the run that makes it is logged. The recorded mode follows, and so does the lock.
    logs.length = 0;
    try {
      await migrate({ adminUrl: sharedUrl, dir: MIGRATIONS, sharedDatabase: false, allowModeSwitch: true, log: (m) => logs.push(m) }).catch(() => undefined);
      expect(logs.some((l) => l.includes('switching the database from shared to owned-database mode'))).toBe(true);
      await expect(migrateShared()).rejects.toThrow(/migrated in owned-database mode and CROVE_SHARED_DATABASE asks for shared/);
    } finally {
      await migrateShared({ allowModeSwitch: true });
    }
    expect((await client.query("SELECT value FROM crove_meta.deployment WHERE key = 'shared_database'")).rows).toEqual([{ value: 'true' }]);
  }, 180_000);

  it('reports the roles of the host that can read and write every org\'s data, without failing the run', async () => {
    logs.length = 0;
    await migrateShared();
    const line = logs.find((l) => l.startsWith('warning: these roles of the host can read and write'));
    expect(line).toBeDefined();
    expect(line).toMatch(/supabase_admin \(superuser/);
  });

  it('never fails another system\'s DDL because of the watch, while a statement that concerns Ludy still fails if it cannot be recorded', async () => {
    if ((await installDdlWatch({ adminUrl: sharedUrl })) !== 'installed') return;
    // The rename itself is DDL the watch would record into the table it moves: the triggers are off for it, and for the rename back.
    const triggers = async (state: 'DISABLE' | 'ENABLE ALWAYS') => {
      for (const t of ['crove_ddl_watch', 'crove_ddl_watch_drop']) await client.query(`ALTER EVENT TRIGGER ${t} ${state}`);
    };
    await triggers('DISABLE');
    await client.query('ALTER TABLE crove_kernel.ddl_event RENAME TO ddl_event_moved');
    await triggers('ENABLE ALWAYS');
    try {
      // The other system's statement does not touch the table at all.
      await withRole('dos_app', (c) => c.query('CREATE TABLE dos_core.unbroken (i int)'));
      await client.query('DROP TABLE dos_core.unbroken');
      // A Ludy role's does, and fails: nothing of Ludy's goes unrecorded.
      await admin.query(`ALTER ROLE crove_prober PASSWORD '${FOREIGN_PASSWORD}'`);
      await client.query('GRANT USAGE, CREATE ON SCHEMA dos_core TO crove_prober');
      await expect(withRole('crove_prober', (c) => c.query('CREATE TABLE dos_core.refused (i int)'))).rejects.toThrow(/ddl_event/);
    } finally {
      await triggers('DISABLE');
      await client.query('ALTER TABLE crove_kernel.ddl_event_moved RENAME TO ddl_event');
      await triggers('ENABLE ALWAYS');
      await client.query('REVOKE ALL ON SCHEMA dos_core FROM crove_prober');
    }
  });

  it('clears the temporary objects of a connection when it goes back to the pool in shared mode, and not otherwise', async () => {
    const survives = async (discardTemp: boolean): Promise<boolean> => {
      const pool = createPool({ connectionString: sharedUrl, max: 1, discardTemp });
      try {
        const first = await pool.connect();
        await first.query('CREATE TEMP TABLE leftover (i int)');
        first.release();
        // One connection in the pool: the next checkout is the same backend, after the reset that ran on release.
        const second = await pool.connect();
        try {
          return (await second.query("SELECT to_regclass('pg_temp.leftover') IS NOT NULL AS there")).rows[0].there as boolean;
        } finally {
          second.release();
        }
      } finally {
        await pool.end();
      }
    };
    expect(await survives(true)).toBe(false);
    expect(await survives(false)).toBe(true);
  });

  // A fresh database in the same container, for a run that must not touch the shared one above.
  const scratch = async (name: string): Promise<{ url: string; drop: () => Promise<void> }> => {
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${name}`);
    return { url: as(adminUrl, decodeURIComponent(new URL(adminUrl).username), decodeURIComponent(new URL(adminUrl).password), name), drop: async () => void (await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)) };
  };

  it('refuses to apply the TEMPORARY revoke itself when its variant cannot be found, and leaves PUBLIC as it was', async () => {
    const db = await scratch(`${DB}_novariant`);
    try {
      const empty = await mkdtemp(join(tmpdir(), 'crove-no-variants-'));
      await expect(migrate({ adminUrl: db.url, dir: MIGRATIONS, sharedDatabase: true, sharedVariantsDir: empty })).rejects.toThrow(/has no shared-database variant/);
      const c = new pg.Client({ connectionString: db.url });
      await c.connect();
      try {
        const { rows } = await c.query("SELECT has_database_privilege('dos_reader', current_database(), 'TEMPORARY') AS temp");
        expect(rows).toEqual([{ temp: true }]);
        expect((await c.query('SELECT count(*)::int AS n FROM crove_meta.schema_migrations WHERE name = $1', [REVOKE_TEMP])).rows).toEqual([{ n: 0 }]);
      } finally {
        await c.end();
      }
    } finally {
      await db.drop();
    }
  }, 120_000);

  it('applies every migration for a dedicated login that is neither postgres nor a superuser, flags the admin that created the roles, and skips the DDL watch', async () => {
    const db = await scratch(`${DB}_login`);
    await dropLogin('ludy_migrate_test');
    await admin.query(`CREATE ROLE ludy_migrate_test LOGIN CREATEROLE NOSUPERUSER PASSWORD '${FOREIGN_PASSWORD}'`);
    await admin.query(`GRANT CREATE ON DATABASE ${db.url.split('/').pop()} TO ludy_migrate_test`);
    // The crove_* roles belong to the cluster and exist from the runs above, made by this container's admin; on a project they are
    // created by the login itself, which then holds ADMIN OPTION on them. Here the login is handed that, as a hand-over would.
    const existing = await admin.query<{ rolname: string }>("SELECT rolname FROM pg_roles WHERE rolname LIKE 'crove\\_%'");
    for (const { rolname } of existing.rows) await admin.query(`GRANT ${pg.escapeIdentifier(rolname)} TO ludy_migrate_test WITH ADMIN OPTION`);
    const url = as(adminUrl, 'ludy_migrate_test', FOREIGN_PASSWORD, `${DB}_login`);
    try {
      const files = await readMigrations(MIGRATIONS);
      // Every file applies; the run then fails the guard, which names the admin that made the roles and can still act as them.
      await expect(migrate({ adminUrl: url, dir: MIGRATIONS, sharedDatabase: true })).rejects.toThrow(/role postgres is not a Ludy role but can act as crove_/);
      const c = new pg.Client({ connectionString: url });
      await c.connect();
      try {
        expect((await c.query('SELECT count(*)::int AS n FROM crove_meta.schema_migrations')).rows).toEqual([{ n: files.length }]);
        const violations = await hardeningViolations(c, { shared: true });
        expect(violations).toHaveLength(1);
        expect(violations[0]).toMatch(/^role postgres is not a Ludy role but can act as /);
      } finally {
        await c.end();
      }
      expect(await installDdlWatch({ adminUrl: url })).toBe('skipped');
    } finally {
      await db.drop();
      await dropLogin('ludy_migrate_test');
    }
  }, 240_000);

  it('fails the guard for a foreign role that can act as a Ludy role', async () => {
    await client.query('GRANT crove_auth_reader TO dos_reader');
    try {
      expect((await hardeningViolations(client, { shared: true })).join('\n')).toMatch(/role dos_reader is not a Ludy role but can act as crove_auth_reader/);
    } finally {
      await client.query('REVOKE crove_auth_reader FROM dos_reader');
    }
    expect(await hardeningViolations(client, { shared: true })).toEqual([]);
  });
});

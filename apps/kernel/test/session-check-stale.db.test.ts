// The obsolete 3-argument session_check from an early draft of the auth sessions migration is dropped (issue #92):
// a dev database that applied the draft, then was recovered by deleting the draft's ledger row (the runner refuses
// the changed checksum otherwise), must not keep a callable overload that skips the org-scoped revocation.
// Set LUDY_TEST_ADMIN_URL (or CROVE_TEST_ADMIN_URL) to a superuser URL; each run creates and drops its own database.
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '@ludy/db/migrate';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const DROP_MIGRATION = '20261016120000_crove_kernel_session_check_drop_stale.sql';
const CUTOVER_FILE = readdirSync(MIGRATIONS).find((n) => n.endsWith('_ludy_kernel_rebrand_core_schemas_roles_gucs.sql'));
if (!CUTOVER_FILE) throw new Error('missing core cutover migration');
const CUTOVER_VERSION = CUTOVER_FILE.slice(0, 14);

const suite = ADMIN ? describe : describe.skip;

suite('stale session_check overload', () => {
  const dbName = `ludy_test_session_check_stale_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';

  async function admin<T>(fn: (client: pg.Client) => Promise<T>, url = adminUrl): Promise<T> {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  const exists = (signature: string, url = adminUrl) =>
    admin(async (c) => (await c.query<{ oid: string | null }>('SELECT to_regprocedure($1)::text AS oid', [signature])).rows[0]?.oid !== null, url);

  beforeAll(async () => {
    const base = new URL(ADMIN as string);
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
  });

  afterAll(async () => {
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('is absent on a fresh install, next to the current check (5 arguments since #126)', async () => {
    expect(await exists('ludy_kernel.session_check(uuid, uuid, boolean)')).toBe(false);
    expect(await exists('ludy_kernel.session_check(uuid, uuid, boolean, uuid)')).toBe(false);
    expect(await exists('ludy_kernel.session_check(uuid, uuid, boolean, uuid, text)')).toBe(true);
  });

  it('is dropped from a database that applied the draft, and the drop is idempotent', async () => {
    const staleDbName = `${dbName}_pre`;
    const before = mkdtempSync(join(tmpdir(), 'crove-session-check-stale-'));
    for (const name of readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql') && n.slice(0, 14) < CUTOVER_VERSION)) {
      copyFileSync(join(MIGRATIONS, name), join(before, name));
    }
    const base = new URL(ADMIN as string);
    base.pathname = `/${staleDbName}`;
    const staleUrl = base.toString();
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${staleDbName}`);
    await root.end();
    try {
      await migrate({ adminUrl: staleUrl, dir: before });
      // What the draft left behind after that recovery: a definer the API role could call.
      await admin(
        (c) =>
          c.query(`
            CREATE FUNCTION crove_kernel.session_check(p_user_id uuid, p_session_id uuid, p_upstream boolean)
            RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$ BEGIN END $$;
            GRANT EXECUTE ON FUNCTION crove_kernel.session_check(uuid, uuid, boolean) TO crove_app;
            DELETE FROM crove_meta.schema_migrations WHERE name = '${DROP_MIGRATION}';
          `),
        staleUrl,
      );
      expect(await exists('crove_kernel.session_check(uuid, uuid, boolean)', staleUrl)).toBe(true);
      expect(await migrate({ adminUrl: staleUrl, dir: before })).toEqual([DROP_MIGRATION]);
      expect(await exists('crove_kernel.session_check(uuid, uuid, boolean)', staleUrl)).toBe(false);
      expect(await exists('crove_kernel.session_check(uuid, uuid, boolean, uuid, text)', staleUrl)).toBe(true);
      // Applied again where the overload is already gone: a no-op, not an error.
      await admin((c) => c.query(`DELETE FROM crove_meta.schema_migrations WHERE name = '${DROP_MIGRATION}'`), staleUrl);
      expect(await migrate({ adminUrl: staleUrl, dir: before })).toEqual([DROP_MIGRATION]);
      // Cut over to ludy_* keeps the 3-arg overload absent next to the active 5-arg overload.
      await migrate({ adminUrl: staleUrl, dir: MIGRATIONS });
      expect(await exists('ludy_kernel.session_check(uuid, uuid, boolean)', staleUrl)).toBe(false);
      expect(await exists('ludy_kernel.session_check(uuid, uuid, boolean, uuid, text)', staleUrl)).toBe(true);
    } finally {
      rmSync(before, { recursive: true, force: true });
      const cleanup = new pg.Client({ connectionString: ADMIN });
      await cleanup.connect();
      await cleanup.query(`DROP DATABASE IF EXISTS ${staleDbName} WITH (FORCE)`);
      await cleanup.end();
    }
  });
});

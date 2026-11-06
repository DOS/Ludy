// The personal-data registry against the database (issue #923, PDPL), on a real PostgreSQL 17. Every column of the
// tenant schemas whose name looks like personal data (an email, a phone, an address, a tax code, a person's name, a
// recipient) is classified in PERSONAL_DATA_COLUMNS (packages/kernel/src/personal-data.ts), so a new one cannot escape
// an erasure request unclassified, or sealed under its subject's key and listed in SEALED_COLUMNS (ADR-0017: a column named for what it holds,
// national_id_sealed, is checked like any other, never renamed to dodge the pattern); and every classified or sealed column exists, so the lists do not rot. Part of the invariant
// suite: CI runs this file from the base branch on protected-path PRs (AGENTS.md). Set CROVE_TEST_ADMIN_URL to a
// superuser URL; the run creates and drops its own database.
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '@crove/db/migrate';
import { PERSONAL_DATA_COLUMNS, PERSONAL_DATA_NAME_PATTERN, PERSONAL_DATA_SCHEMAS, SEALED_COLUMNS } from '@crove/kernel';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));

// Control-plane tables: not tenant data, never read by tenant code (control-plane-reads.test.ts keeps the list).
const CONTROL_PLANE = ['user_account', 'auth_session', 'inbound_address', 'inbound_pending', 'auth_email_send', 'stream_ticket', 'global_kill_switch'];

const suite = ADMIN ? describe : describe.skip;

suite('personal-data registry (#923)', () => {
  const dbName = `crove_test_pdpl_inv_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';

  beforeAll(async () => {
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    const base = new URL(ADMIN as string);
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

  async function columns(where: string, params: unknown[]): Promise<string[]> {
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    try {
      const { rows } = await admin.query<{ key: string }>(
        `SELECT n.nspname || '.' || c.relname || '.' || a.attname AS key
           FROM pg_catalog.pg_attribute a
           JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
           JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          WHERE c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped AND ${where}
          ORDER BY 1`,
        params,
      );
      return rows.map((r) => r.key);
    } finally {
      await admin.end();
    }
  }

  it('classifies every column of the tenant schemas whose name looks like personal data', async () => {
    const found = await columns(`n.nspname = ANY($1::text[]) AND a.attname ~ $2 AND NOT (n.nspname = 'crove_kernel' AND c.relname = ANY($3::text[]))`, [
      [...PERSONAL_DATA_SCHEMAS],
      PERSONAL_DATA_NAME_PATTERN,
      CONTROL_PLANE,
    ]);
    expect(found.length).toBeGreaterThan(15);
    const unclassified = found.filter((key) => !(key in PERSONAL_DATA_COLUMNS) && !(key in SEALED_COLUMNS));
    expect(unclassified, 'classify these in packages/kernel/src/personal-data.ts (PERSONAL_DATA_COLUMNS, or SEALED_COLUMNS for a column sealed under its subject key)').toEqual([]);
  });

  // A sealed column holds sealed text, never a plain value: its type is text, and a single-column CHECK of its table, bound to the column by its attribute number (not by
  // matching its name in the text), requires the `crove:s1:` prefix, so listing a plain column as sealed to get past the name pattern fails here. Passes on main, where the
  // list is empty.
  it('lists a column as sealed only when it is text and a CHECK on that column alone requires the sealed prefix', async () => {
    const problems: string[] = [];
    for (const place of Object.keys(SEALED_COLUMNS)) {
      const [schema, table, column] = place.split('.') as [string, string, string];
      const admin = new pg.Client({ connectionString: adminUrl });
      await admin.connect();
      try {
        const { rows: columns } = await admin.query<{ type: string; attnum: number; relid: number }>(
          `SELECT format_type(a.atttypid, a.atttypmod) AS type, a.attnum, c.oid AS relid FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid = a.attrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = $1 AND c.relname = $2 AND a.attname = $3 AND a.attnum > 0 AND NOT a.attisdropped`,
          [schema, table, column],
        );
        const found = columns[0];
        if (!found) {
          problems.push(`${place} does not exist`);
          continue;
        }
        if (found.type !== 'text') problems.push(`${place} is ${found.type}, not text`);
        const { rowCount } = await admin.query(
          `SELECT 1 FROM pg_catalog.pg_constraint k WHERE k.contype = 'c' AND k.conrelid = $1 AND $2 = ANY (k.conkey) AND cardinality(k.conkey) = 1 AND pg_get_constraintdef(k.oid) LIKE '%crove:s1:%'`,
          [found.relid, found.attnum],
        );
        if (!rowCount) problems.push(`${place} has no CHECK on that column alone that requires crove:s1:`);
      } finally {
        await admin.end();
      }
    }
    expect(problems).toEqual([]);
  });

  it('lists only columns that exist', async () => {
    const keys = [...Object.keys(PERSONAL_DATA_COLUMNS), ...Object.keys(SEALED_COLUMNS)];
    const existing = new Set(await columns(`n.nspname || '.' || c.relname || '.' || a.attname = ANY($1::text[])`, [keys]));
    expect(keys.filter((key) => !existing.has(key))).toEqual([]);
  });
});

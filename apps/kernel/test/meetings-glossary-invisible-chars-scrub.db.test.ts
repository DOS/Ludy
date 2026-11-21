// SPDX-License-Identifier: AGPL-3.0-only
// Widening crove_meetings.glossary_term_ok and enforcing NFKC address checks (#4137 points 2b and 3) on PostgreSQL 17:
// builds the database as it stood right before 20270130120000, inserts rows that the old CHECK allowed (including the four widened invisible ranges, colliding cleaned terms, lone U+FFA0,
// address smuggling via U+FFA0, and NFKC look-alikes), runs the migration (twice for idempotency), and verifies scrubbing, constraint validation, rejection of every widened edge and look-alike,
// and acceptance of adjacent non-invisible characters and valid dotted terms. Set CROVE_TEST_ADMIN_URL to a superuser URL.
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { meetingsCommands, meetingsQueries } from '@crove/mod-meetings';
import { TEST_MANIFESTS } from './invariant/fixtures/manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const VERSION = '20270130120000';
const suite = ADMIN ? describe : describe.skip;

const NEW_EDGES = [0x180b, 0x180d, 0x206a, 0x206f, 0xffa0, 0x1d173, 0x1d17a];
const BIDI_EDGES = [0x200b, 0x200f, 0x202e, 0x2066, 0x2069, 0xfeff, 0xe0041];
const OUTSIDE = [0x2070, 0xffa1, 0x1d172, 0x1d17b, 0xfe0f];
const LOOK_ALIKES = [
  'an＠example.com',
  'a﹫b',
  'www．example.com',
  'www․example.com',
  'www﹒example.com',
  'www‥example.com',
  'www…example.com',
  'wｗw．example.com',
  'ⓦⓦⓦ.example.com',
  '𝐰𝐰𝐰.example.com',
  'ｈｔｔｐｓ：／／example.com',
  'https﹕／／example.com',
  'https︓／／example.com',
];
const ch = (point: number) => String.fromCodePoint(point);

suite('glossary_term_ok widening and NFKC address check (#4137 points 2b and 3)', () => {
  const dbName = `crove_test_glossary_widen_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let before = '';
  let pool: pg.Pool | undefined;
  let orgId = '';
  let userId = '';
  let runtime: Runtime;
  const ids: Record<string, string> = {};

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }
  const sql = <R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params: unknown[] = []) => admin((c) => c.query<R>(text, params));
  const insertTerm = async (term: string) =>
    (await sql<{ id: string }>(`INSERT INTO crove_meetings.glossary_term (org_id, term, created_by) VALUES ($1, $2, $3) RETURNING id`, [orgId, term, userId])).rows[0]!.id;
  const termOf = async (id: string) => (await sql<{ term: string }>(`SELECT term FROM crove_meetings.glossary_term WHERE org_id = $1 AND id = $2`, [orgId, id])).rows[0]?.term;

  beforeAll(async () => {
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();

    before = mkdtempSync(join(tmpdir(), 'crove-glossary-invisible-before-'));
    for (const name of readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql') && n.slice(0, 14) < VERSION)) copyFileSync(join(MIGRATIONS, name), join(before, name));
    await migrate({ adminUrl, dir: before });
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });

    const app = new URL(adminUrl);
    app.username = 'crove_app';
    app.password = 'test-app-pw';
    pool = createPool({ connectionString: app.toString(), max: 2 });
    const db = createDb(pool);
    const registry = { commands: [...kernelCommands, ...meetingsCommands], queries: [...kernelQueries({ inboundDomain: null }), ...meetingsQueries] };
    runtime = new Runtime(db, { manifests: TEST_MANIFESTS }).register(registry);
    userId = await upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: 'owner@glossary-widen.test', name: null });
    ({ orgId } = await createOrg(runtime, { type: 'user', userId, aal: 'aal1' }, 'Tổ chức thuật ngữ'));

    // Pre-migration rows allowed by the old 20270122100000 CHECK.
    const hidden = `${ch(0x206a)}${ch(0x180b)}${ch(0xffa0)}${ch(0x1d173)}`;
    ids.scrubbed = await insertTerm(`MISA${hidden}AMIS`);
    ids.clean = await insertTerm('Ludy');
    ids.collideDirty = await insertTerm(`Ludy${ch(0x206f)}`);
    ids.pairA = await insertTerm(`Thuật${ch(0x206a)}`);
    ids.pairB = await insertTerm(`thuật${ch(0x206b)}`);
    ids.longClean = await insertTerm(`Crove 2026 ${'x'.repeat(28)}`);
    ids.longDirty = await insertTerm(`Crove 2026 ${'x'.repeat(28)}${ch(0x1d17a)}`);
    // Un-salvageable rows allowed under the old CHECK (lone U+FFA0, digits + U+FFA0, smuggled www., NFKC look-alikes).
    ids.loneFiller = await insertTerm(ch(0xffa0));
    ids.digitsFiller = await insertTerm(`1234${ch(0xffa0)}`);
    ids.smuggledWww = await insertTerm(`www${ch(0xffa0)}.example.com`);
    ids.fullwidthAt = await insertTerm('an＠example.com');
    ids.fullwidthWww = await insertTerm('www．example.com');

    await migrate({ adminUrl, dir: MIGRATIONS });
  }, 300_000);

  afterAll(async () => {
    await pool?.end();
    if (before) rmSync(before, { recursive: true, force: true });
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('scrubs surviving terms, resolves collisions without adding digits, and drops un-salvageable rows', async () => {
    expect(await termOf(ids.scrubbed!)).toBe('MISAAMIS');
    expect(await termOf(ids.clean!)).toBe('Ludy');
    const collided = await termOf(ids.collideDirty!);
    expect(collided).toMatch(/^Ludy [a-p]{8}$/);
    const pairA = await termOf(ids.pairA!);
    const pairB = await termOf(ids.pairB!);
    expect(pairA).toMatch(/^Thuật [a-p]{8}$/);
    expect(pairB).toMatch(/^thuật [a-p]{8}$/);
    expect(pairA!.toLowerCase()).not.toBe(pairB!.toLowerCase());
    const longDirty = await termOf(ids.longDirty!);
    expect(longDirty).toMatch(/^Crove 2026 x{20} [a-p]{8}$/);
    expect(Array.from(longDirty!).length).toBe(40);
    expect((longDirty!.match(/\d/g) ?? []).length).toBe(4);
    for (const droppedId of [ids.loneFiller!, ids.digitsFiller!, ids.smuggledWww!, ids.fullwidthAt!, ids.fullwidthWww!]) {
      expect(await termOf(droppedId), droppedId).toBeUndefined();
    }
  });

  it('validates glossary_term_term_check and reapplies idempotently', async () => {
    const con = (
      await sql<{ convalidated: boolean; def: string }>(
        `SELECT con.convalidated, pg_catalog.pg_get_constraintdef(con.oid) AS def
           FROM pg_catalog.pg_constraint con
           JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
           JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'crove_meetings' AND c.relname = 'glossary_term' AND con.conname = 'glossary_term_term_check'`,
      )
    ).rows[0];
    expect(con).toEqual({ convalidated: true, def: 'CHECK (crove_meetings.glossary_term_ok(term))' });
    // Running the migration SQL directly a second time in one transaction is idempotent, and migrate skips applied files.
    const migrationSql = readFileSync(join(MIGRATIONS, `${VERSION}_crove_meetings_glossary_invisible_chars.sql`), 'utf8');
    await admin(async (c) => {
      await c.query('BEGIN');
      try {
        await c.query(migrationSql);
        await c.query('COMMIT');
      } catch (error) {
        await c.query('ROLLBACK');
        throw error;
      }
    });
    expect(await migrate({ adminUrl, dir: MIGRATIONS })).toEqual([]);
  });

  it('rejects every widened invisible and bidi edge plus NFKC address look-alikes, and accepts outside neighbours', async () => {
    for (const point of [...NEW_EDGES, ...BIDI_EDGES]) {
      const label = `U+${point.toString(16)}`;
      await expect(insertTerm(`a${ch(point)}b`), label).rejects.toMatchObject({ code: '23514' });
      await expect(insertTerm(ch(point)), `lone ${label}`).rejects.toMatchObject({ code: '23514' });
    }
    for (const bad of LOOK_ALIKES) {
      await expect(insertTerm(bad), bad).rejects.toMatchObject({ code: '23514' });
    }
    for (const [idx, point] of OUTSIDE.entries()) {
      await expect(insertTerm(`Ngoại ${String.fromCharCode(97 + idx)} a${ch(point)}b`), `outside U+${point.toString(16)}`).resolves.toBeTruthy();
    }
    for (const fine of ['Node.js', 'C.E.O', 'Cơ sở Q1']) {
      const res = await runtime.execute<{ termId: string }>('meetings.glossary.add', { term: fine }, { actor: { type: 'user', userId, aal: 'aal1' }, orgId });
      expect(await termOf(res.termId)).toBe(fine);
    }
  });
});

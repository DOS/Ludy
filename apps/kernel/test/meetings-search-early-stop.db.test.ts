// SPDX-License-Identifier: AGPL-3.0-only
// crove_meetings.search_segment_ids after migration 20270116200000 (#3843): the page is read meeting by meeting in the order of the answer and stopped when full, and falls back to the
// statement of 20261226000000 when 40 meetings were not enough. The proof is a comparison against that statement, kept here as a reference function of the test database only: the same
// ids in the same order, for an owner, an admin, a recorder, a reader and a member who reads nothing, over common, rare and unreadable-only words, pages and offsets, with drafts and a meeting
// past its text date; and a count of the readability checks (pg_stat_user_functions), so the saving is measured by the database and not by a clock.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { contextToken } from './invariant/fixtures/context-token.ts';
import { TEST_MANIFESTS } from './invariant/fixtures/manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('crove_meetings.search_segment_ids reads the first page early and answers what it answered before (#3843)', () => {
  const dbName = `crove_test_meetings_search_early_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  const pools: pg.Pool[] = [];
  let orgId = '';
  const users: Record<string, string> = {};
  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }
  const sqlAdmin = <R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params: unknown[] = []) => admin((c) => c.query<R>(text, params));
  async function asUser<T>(who: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: appUrl });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [orgId, contextToken(users[who] as string, orgId)]);
      return await fn(c);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      await c.end();
    }
  }
  const ids = async (c: pg.Client, fn: string, q: string, limit: number, offset: number): Promise<string[]> =>
    (await c.query<{ id: string }>(`SELECT id FROM crove_meetings.${fn}($1, $2, $3)`, [q, limit, offset])).rows.map((r) => r.id);

  async function meetings(count: number, recorder: string, visibility: 'org' | 'attendees', readers: string[], held: (g: number) => string, lines: (g: number) => string[], stage: 'published' | 'draft' = 'published'): Promise<string[]> {
    const made: string[] = [];
    for (let g = 1; g <= count; g++) {
      const id = randomUUID();
      made.push(id);
      await sqlAdmin(
        `INSERT INTO crove_meetings.meeting (org_id, id, title, language, started_at, ended_at, length_seconds, recorder_user_id, visibility, status, consent_method, consent_confirmed_by, consent_confirmed_at, consent_notice_version, audio_retention_date, text_retention_date)
         VALUES ($1, $2, $3, 'vi', $4::timestamptz, $4::timestamptz + interval '30 minutes', 1800, $5, $6, 'ready', 'told_at_start', $5, now(), '1.0', current_date + 20, current_date + 365)`,
        [orgId, id, `Họp ${id.slice(0, 8)}`, held(g), users[recorder], visibility],
      );
      for (const reader of readers) await sqlAdmin(`INSERT INTO crove_meetings.meeting_reader (org_id, id, meeting_id, user_id) VALUES ($1, $2, $3, $4)`, [orgId, randomUUID(), id, users[reader]]);
      let start = 0;
      for (const text of lines(g)) {
        await sqlAdmin(`INSERT INTO crove_meetings.transcript_segment (org_id, meeting_id, start_seconds, end_seconds, speaker_label, text, stage) VALUES ($1, $2, $3::numeric, $3::numeric + 1, 'Hà', $4, $5)`, [orgId, id, start, text, stage]);
        start += 2;
      }
    }
    return made;
  }

  beforeAll(async () => {
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw' });
    await sqlAdmin(`ALTER DATABASE ${dbName} SET track_functions = 'all'`);
    // The statement of 20261226000000, kept under another name in this test database only, as the reference.
    const original = readFileSync(`${MIGRATIONS}/20261226000000_crove_meetings_search.sql`, 'utf8');
    const body = original.slice(original.indexOf('CREATE OR REPLACE FUNCTION crove_meetings.search_segment_ids'), original.indexOf('REVOKE ALL ON FUNCTION crove_meetings.search_segment_ids'));
    await sqlAdmin(body.replace('search_segment_ids', 'search_segment_ids_reference'));
    await sqlAdmin('GRANT EXECUTE ON FUNCTION crove_meetings.search_segment_ids_reference(text, integer, integer) TO crove_tenant');
    const url = new URL(adminUrl);
    url.username = 'crove_app';
    url.password = 'test-app-pw';
    appUrl = url.toString();
    const pool = createPool({ connectionString: url.toString(), max: 2 });
    pools.push(pool);
    for (const key of ['owner', 'admin', 'recorder', 'reader', 'stranger', 'viewer']) users[key] = await upsertIdentity(createDb(pool), { issuer: 'meetings-early', subject: key, email: `${key}@meetings-early.test`, name: null });
    const runtime = new Runtime(createDb(pool), { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands], queries: [...kernelQueries({ inboundDomain: null })] });
    orgId = (await createOrg(runtime, { type: 'user', userId: users.owner as string, aal: 'aal1' }, 'Tìm sớm')).orgId;
    await sqlAdmin(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'member'), ($1, $5, 'member'), ($1, $6, 'viewer')`, [orgId, users.admin, users.recorder, users.reader, users.stranger, users.viewer]);
    const day = (g: number) => `2026-0${1 + (g % 9)}-${String(1 + (g % 27)).padStart(2, '0')}T0${g % 9}:00:00Z`;
    // 90 meetings shared with the org: every line says "giá" (common), a third also "báo giá", 1 in 30 "chiết khấu"; and meeting 7 alone holds "đặc biệt" in a line of its own.
    await meetings(90, 'recorder', 'org', [], day, (g) => [`Nói về giá hàng tuần ${g}`, g % 3 === 0 ? 'Gửi báo giá cho khách' : 'Giá đã chốt', g % 30 === 0 ? 'Cho chiết khấu mười phần trăm' : 'Giá tốt nhé', g === 7 ? 'Việc đặc biệt giá riêng' : 'Hết giờ']);
    // 40 attendees-only meetings of the recorder with the reader: the same words, drafts included.
    await meetings(40, 'recorder', 'attendees', ['reader'], (g) => day(g + 3), (g) => [`Họp kín giá ${g}`, 'Báo giá riêng cho Minh Phát', 'Đặc biệt giá nội bộ']);
    await meetings(5, 'recorder', 'attendees', ['reader'], (g) => day(g + 11), (g) => [`Nháp giá ${g}`, 'Nháp báo giá'], 'draft');
    // Meetings nobody but their recorder reads (the stranger's): many lines of a word the others never write besides one.
    await meetings(60, 'stranger', 'attendees', [], (g) => day(g + 5), () => ['Chuyện riêng về khuyến mãi lớn', 'Khuyến mãi tháng này', 'Giá riêng của người lạ']);
    // The owner's own meetings, with a draft.
    await meetings(3, 'owner', 'attendees', [], (g) => day(g + 20), () => ['Của chủ về giá', 'Nháp khuyến mãi'], 'draft');
    // A meeting past its text date: left out for everyone.
    const [expired] = await meetings(1, 'recorder', 'org', [], () => '2026-01-02T03:00:00Z', () => ['Hết hạn về giá đặc biệt khuyến mãi']);
    await sqlAdmin(`UPDATE crove_meetings.meeting SET text_retention_date = (timezone('Asia/Ho_Chi_Minh', now()))::date WHERE id = $1`, [expired]);
    await sqlAdmin('ANALYZE crove_meetings.transcript_segment');
  }, 600_000);

  afterAll(async () => {
    for (const pool of pools) await pool.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  const QUERIES = ['giá', 'báo giá', 'chiết khấu', 'đặc biệt', 'Minh Phát', 'khuyến mãi', 'người lạ', 'giá hàng tuần', 'nháp', 'không có từ này', 'hết hạn', 'g'];
  const PAGES: Array<[number, number]> = [[21, 0], [51, 0], [30, 20], [51, 200], [1, 0], [5, 3]];

  it('answers the same ids in the same order as the statement it replaced, for every kind of reader, on every kind of word and page', async () => {
    let compared = 0;
    let nonEmpty = 0;
    const found: Record<string, number> = {};
    for (const who of ['owner', 'admin', 'recorder', 'reader', 'stranger']) {
      await asUser(who, async (c) => {
        for (const q of QUERIES) {
          for (const [limit, offset] of PAGES) {
            const before = await ids(c, 'search_segment_ids_reference', q, limit, offset);
            const after = await ids(c, 'search_segment_ids', q, limit, offset);
            expect(after, `${who} "${q}" ${limit}/${offset}`).toEqual(before);
            compared += 1;
            if (after.length > 0) nonEmpty += 1;
            found[`${who} ${q}`] = Math.max(found[`${who} ${q}`] ?? 0, after.length);
          }
        }
      });
    }
    expect(compared).toBe(5 * QUERIES.length * PAGES.length);
    // Not a pass on empty answers.
    expect(nonEmpty).toBeGreaterThan(compared / 3);
    // The shapes the cases are meant to reach: a common word fills a page for a reader (the early way); "Minh Phát" is held only by meetings an owner or admin does not read, after more than 40 readable
    // meetings were visited, so they are answered by the old way, with nothing; an owner and an admin read the org's meetings only; a stranger reads their own and the org's; a word only in meetings nobody they are no reader of write is found by nobody else.
    expect(found['reader giá']).toBe(51);
    expect(found['owner đặc biệt']).toBeGreaterThan(0);
    expect(found['stranger khuyến mãi']).toBeGreaterThan(0);
    expect(found['reader khuyến mãi'] ?? 0).toBe(0);
    expect(found['admin khuyến mãi'] ?? 0).toBe(0);
    expect(found['owner hết hạn'] ?? 0).toBe(0);
    expect(found['owner g'] ?? 0).toBe(0);
    expect(found['owner Minh Phát'] ?? 0).toBe(0);
    expect(found['reader Minh Phát']).toBeGreaterThan(0);
  }, 300_000);

  it('checks the readability of a few meetings for a common word, where the statement it replaced checked every meeting with a hit', async () => {
    const checks = async (fn: string): Promise<number> => {
      await sqlAdmin(`SELECT pg_catalog.pg_stat_reset_single_function_counters('crove_meetings.is_meeting_reader(uuid, uuid, uuid)'::regprocedure)`);
      await asUser('reader', async (c) => {
        await ids(c, 'search_segment_ids' + fn, 'giá', 21, 0);
        await c.query('SELECT pg_catalog.pg_stat_force_next_flush()');
      });
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return Number((await sqlAdmin<{ calls: string }>(`SELECT COALESCE(sum(calls), 0) AS calls FROM pg_catalog.pg_stat_user_functions WHERE funcname = 'is_meeting_reader'`)).rows[0]?.calls ?? 0);
    };
    const reference = await checks('_reference');
    const early = await checks('');
    // The reference checks every meeting that has a hit (about 200); the early way at most the 40 it visits, a common word needing only the first two.
    expect(reference).toBeGreaterThan(100);
    expect(early).toBeLessThanOrEqual(41);
    expect(early).toBeLessThan(reference / 3);
  }, 60_000);

  it('keeps its checks, its owner and its grants: an owner, admin or member of a user context only, no PUBLIC or worker grant, ids only', async () => {
    await expect(asUser('viewer', (c) => ids(c, 'search_segment_ids', 'giá', 21, 0))).rejects.toMatchObject({ code: '42501' });
    await expect(asUser('owner', (c) => ids(c, 'search_segment_ids', 'giá', 52, 0))).rejects.toMatchObject({ code: '22023' });
    await expect(asUser('owner', (c) => ids(c, 'search_segment_ids', 'giá', 21, 201))).rejects.toMatchObject({ code: '22023' });
    expect(await asUser('owner', (c) => ids(c, 'search_segment_ids', '!!', 21, 0))).toEqual([]);
    const acl = (
      await sqlAdmin<{ acl: string; secdef: boolean; config: string[] | null; public_exec: boolean }>(
        `SELECT p.proacl::text AS acl, p.prosecdef AS secdef, p.proconfig AS config, pg_catalog.has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec
           FROM pg_catalog.pg_proc p WHERE p.oid = 'crove_meetings.search_segment_ids(text, integer, integer)'::regprocedure`,
      )
    ).rows[0];
    expect(acl).toMatchObject({ secdef: true, public_exec: false });
    expect(acl?.config?.some((s) => s === 'search_path=pg_catalog, pg_temp')).toBe(true);
    // Granted to its owner and crove_tenant, and to nobody else (the reference function keeps the default grant to PUBLIC, which is why its ACL is not compared).
    expect(acl?.acl).toMatch(/^\{[a-z_]+=X\/[a-z_]+,crove_tenant=X\/[a-z_]+\}$/);
  });
});

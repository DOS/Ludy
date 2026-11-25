// SPDX-License-Identifier: AGPL-3.0-only
// The widening of the invisible-character class (Meetings #4137, point 2) on PostgreSQL 17: the database is made as it was before 20270122120000, rows that hold the four ranges the class missed
// (U+180B to U+180D, U+206A to U+206F, U+FFA0, U+1D173 to U+1D17A) are written as the old CHECKs allowed them, then the migration runs. The rows come out clean (a title that would be empty is a dash, a
// name that would equal another active template's takes the last eight characters of its id, the meeting's copy of a template has its hash made again), the CHECKs refuse each new range at both
// edges, and what lies just outside the class still passes. Set LUDY_TEST_ADMIN_URL (or CROVE_TEST_ADMIN_URL) to a superuser URL; each run makes its own database.
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import { Runtime } from '@ludy/kernel-runtime';
import { TEST_MANIFESTS } from './invariant/fixtures/manifests.ts';
import { createPreCutoverClient, createPreCutoverPool } from './pre-cutover-db.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const VERSION = '20270122120000';
const suite = ADMIN ? describe : describe.skip;
// The first and the last code point of each range the class missed.
const NEW_EDGES = [0x180b, 0x180d, 0x206a, 0x206f, 0xffa0, 0x1d173, 0x1d17a];
// Just outside the class: still text.
const OUTSIDE = [0x2070, 0xffa1, 0x1d172, 0x1d17b, 0xfe0f];
const ch = (point: number) => String.fromCodePoint(point);

suite('widening the invisible-character class of the minutes templates and the chapter titles (#4137)', () => {
  const dbName = `ludy_test_invisible_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let before = '';
  let upgraded = false;
  let pool: pg.Pool | undefined;
  let orgId = '';
  let userId = '';
  let meetingId = '';
  const ids: Record<string, string> = {};
  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = upgraded ? new pg.Client({ connectionString: adminUrl }) : createPreCutoverClient({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }
  const sql = <R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params: unknown[] = []) => admin((c) => c.query<R>(text, params));
  const sections = (title: string, hint = 'Ghi rõ') => [{ key: 's1', title, hint }];
  const template = async (name: string, secs: unknown, archived = false) =>
    (await sql<{ id: string }>(`INSERT INTO ludy_meetings.minutes_template (org_id, name, sections, archived_at, created_by) VALUES ($1, $2, $3::jsonb, $4, $5) RETURNING id`, [orgId, name, JSON.stringify(secs), archived ? new Date() : null, userId])).rows[0]!.id;
  const chapterRow = async (position: number, title: string) =>
    (await sql<{ id: string }>(`INSERT INTO ludy_meetings.meeting_chapter (org_id, meeting_id, position, title, start_seconds) VALUES ($1, $2, $3, $4, $5) RETURNING id`, [orgId, meetingId, position, title, position * 10])).rows[0]!.id;
  const templateRow = async (id: string) => (await sql<{ name: string; sections: Array<{ key: string; title: string; hint: string }> }>(`SELECT name, sections FROM ludy_meetings.minutes_template WHERE org_id = $1 AND id = $2`, [orgId, id])).rows[0]!;
  const titleOf = async (id: string) => (await sql<{ title: string }>(`SELECT title FROM ludy_meetings.meeting_chapter WHERE org_id = $1 AND id = $2`, [orgId, id])).rows[0]!.title;

  beforeAll(async () => {
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    // The database as it was before this migration.
    before = mkdtempSync(join(tmpdir(), 'crove-invisible-before-'));
    for (const name of readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql') && n.slice(0, 14) < VERSION)) copyFileSync(join(MIGRATIONS, name), join(before, name));
    await migrate({ adminUrl, dir: before });
    pool = createPreCutoverPool({ connectionString: adminUrl, sessionRole: 'crove_app', max: 2 });
    const db = createDb(pool);
    const rt = new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: null }) });
    userId = await upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: 'owner@invisible.test', name: null });
    ({ orgId } = await createOrg(rt, { type: 'user', userId, aal: 'aal1' }, 'Tổ chức ký tự ẩn'));
    // Rows that hold the new ranges, which the old class lets in.
    const hidden = `${ch(0x206a)}${ch(0x180b)}${ch(0xffa0)}${ch(0x1d173)}`;
    ids.a = await template(`Họp${ch(0x206a)} tuần`, sections(`Mục${hidden}tiêu`, `${hidden}Ghi${ch(0x206f)} rõ${hidden}`));
    ids.b = await template('Họp tuần', sections('Nội dung'));
    ids.c = await template('Mẫu sạch', sections('Quyết định', ''));
    ids.d = await template(`Mẫu cũ${ch(0x1d17a)}`, sections(hidden), true);
    // Two names that clean to the same name, created together (their ids share the first characters, which are a timestamp): both take a suffix, and the suffixes differ.
    ids.f = await template(`Mẫu X${ch(0x206a)}`, sections('Nội dung'));
    ids.g = await template(`mẫu x${ch(0x206b)}`, sections('Nội dung'));
    ids.e = await template(ch(0xffa0), sections(`${ch(0x180c)}${ch(0x180d)}`, ch(0x206b)));
    meetingId = (
      await sql<{ id: string }>(
        `INSERT INTO ludy_meetings.meeting (org_id, recorder_user_id, title, consent_method, consent_confirmed_by, consent_notice_version, audio_retention_date, text_retention_date,
                                              summary_template, minutes_template_name, minutes_template_sections, minutes_template_hash)
         VALUES ($1, $2, 'Họp thử', 'platform_notice', $2, '2026-11-imp-v1', current_date + 7, current_date + 30, 'custom', $4, $3::jsonb, md5($3::jsonb::text)) RETURNING id`,
        [orgId, userId, JSON.stringify(sections(`Tiêu${hidden}đề`, `Gợi${hidden}ý`)), `Bản${ch(0x206c)} sao`],
      )
    ).rows[0]!.id;
    ids.k1 = await chapterRow(1, `Mở${ch(0x206f)}đầu`);
    ids.k2 = await chapterRow(2, `${ch(0x180c)}${ch(0x180d)}`);
    ids.k3 = await chapterRow(3, 'Kết luận');
    await migrate({ adminUrl, dir: MIGRATIONS });
    upgraded = true;
    await setRolePasswords(adminUrl, { ludy_app: 'test-app-pw', ludy_worker: 'test-worker-pw' });
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

  it('cleans the templates: the characters go, an empty title becomes a dash, a clean row is left as it is', async () => {
    const a = await templateRow(ids.a!);
    expect(a.sections).toEqual([{ key: 's1', title: 'Mụctiêu', hint: 'Ghi rõ' }]);
    expect(await templateRow(ids.c!)).toEqual({ name: 'Mẫu sạch', sections: [{ key: 's1', title: 'Quyết định', hint: '' }] });
    expect((await templateRow(ids.e!)).name).toBe('-');
    expect((await templateRow(ids.e!)).sections).toEqual([{ key: 's1', title: '-', hint: '' }]);
    // The archived template's name is cleaned and, being archived, needs no suffix.
    expect((await templateRow(ids.d!)).name).toBe('Mẫu cũ');
  });

  it('gives a template whose cleaned name equals another active template\'s name the last eight characters of its id, and leaves the other one alone', async () => {
    expect((await templateRow(ids.b!)).name).toBe('Họp tuần');
    expect((await templateRow(ids.a!)).name).toBe(`Họp tuần ${ids.a!.slice(-8)}`);
    const f = (await templateRow(ids.f!)).name;
    const g = (await templateRow(ids.g!)).name;
    expect(f).toBe(`Mẫu X ${ids.f!.slice(-8)}`);
    expect(g).toBe(`mẫu x ${ids.g!.slice(-8)}`);
    expect(f.toLowerCase()).not.toBe(g.toLowerCase());
  });

  it('cleans the meeting\'s copy of a template and makes its hash again, so the copy\'s CHECK holds and the meeting can be updated', async () => {
    const row = (await sql<{ s: unknown; h: string; n: string }>(`SELECT minutes_template_sections AS s, minutes_template_hash AS h, minutes_template_name AS n FROM ludy_meetings.meeting WHERE org_id = $1 AND id = $2`, [orgId, meetingId])).rows[0]!;
    expect(row.s).toEqual([{ key: 's1', title: 'Tiêuđề', hint: 'Gợiý' }]);
    expect(row.n).toBe('Bản sao');
    expect(row.h).toBe((await sql<{ h: string }>(`SELECT md5(minutes_template_sections::text) AS h FROM ludy_meetings.meeting WHERE org_id = $1 AND id = $2`, [orgId, meetingId])).rows[0]!.h);
    await expect(sql(`UPDATE ludy_meetings.meeting SET title = 'Họp đã sửa' WHERE org_id = $1 AND id = $2`, [orgId, meetingId])).resolves.toMatchObject({ rowCount: 1 });
  });

  it('cleans the chapter titles (a title that would be empty is a dash) and leaves a clean one', async () => {
    expect(await titleOf(ids.k1!)).toBe('Mởđầu');
    expect(await titleOf(ids.k2!)).toBe('-');
    expect(await titleOf(ids.k3!)).toBe('Kết luận');
  });

  it('refuses each new range at both edges in a chapter title, a template name and a section title or hint, and lets what is just outside the class pass', async () => {
    for (const point of NEW_EDGES) {
      const bad = `a${ch(point)}b`;
      const label = `U+${point.toString(16)}`;
      await expect(chapterRow(9, bad), label).rejects.toMatchObject({ code: '23514' });
      await expect(template(bad, sections('Nội dung')), label).rejects.toMatchObject({ code: '23514' });
      await expect(template(`Mẫu ${point}`, sections(bad)), label).rejects.toMatchObject({ code: '23514' });
      await expect(template(`Mẫu ${point}`, sections('Nội dung', bad)), label).rejects.toMatchObject({ code: '23514' });
    }
    let position = 4;
    for (const point of OUTSIDE) {
      const fine = `a${ch(point)}b`;
      await chapterRow(position++, fine);
      await template(`Mẫu ngoài ${point}`, sections(fine, fine));
    }
  });
});

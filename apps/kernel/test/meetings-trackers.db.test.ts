// SPDX-License-Identifier: AGPL-3.0-only
// Keyword trackers (#4818) on a real database: an owner or admin keeps up to 20 words, every member reads the list, nobody else writes it; a meeting says how often each word came up and at which
// seconds, counted by code from the lines the caller reads (a reader the published lines, the recorder the draft); a week lists the hits across the meetings the caller reads, never those they cannot;
// a member who cannot read a meeting finds no meeting; and the audit rows hold ids and counts, never a word.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import { TRACKER_TERMS_MAX, type TrackerDone, type TrackerHits, type TrackerTerms, type TrackerWeek } from '@ludy/kernel-contract';
import { Runtime } from '@ludy/kernel-runtime';
import { meetingsCommands, meetingsQueries } from '@ludy/mod-meetings';
import { TEST_MANIFESTS } from './invariant/fixtures/manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('Keyword trackers (#4818)', () => {
  const dbName = `ludy_test_tracker_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  const pools: pg.Pool[] = [];
  let orgId = '';
  let runtime: Runtime;
  const users: Record<string, string> = {};
  const NAMES: Record<string, string> = { owner: 'Chủ Công Ty', adm: 'Quản Trị Viên', rec: 'Phạm Quang Minh', lan: 'Trần Thị Lan', nam: 'Nguyễn Văn Nam', other: 'Bạn Không Đọc' };
  const asUser = (who: string) => ({ type: 'user' as const, userId: users[who] as string, aal: 'aal1' as const });
  const run = <T>(command: string, who: string, input: unknown) => runtime.execute<T>(command, input, { actor: asUser(who), orgId });
  const ask = <T>(query: string, who: string, input: unknown) => runtime.query<T>(query, input, { actor: asUser(who), orgId });
  const add = (who: string, term: string) => run<TrackerDone>('meetings.tracker.add', who, { term });
  const remove = (who: string, termId: string) => run<TrackerDone>('meetings.tracker.remove', who, { termId });
  // The list is ordered by the database's collation, which the test does not depend on.
  const terms = (who: string) => ask<TrackerTerms>('meetings.tracker.list', who, {}).then((r) => r.terms.map((t) => t.term).sort());
  const hits = (who: string, meetingId: string) => ask<TrackerHits>('meetings.tracker.hits', who, { meetingId });
  const week = (who: string, weeksBack = 0) => ask<TrackerWeek>('meetings.tracker.week', who, { weeksBack });
  // Start from an empty list in every test.
  const clearTerms = () => sqlAdmin('DELETE FROM ludy_meetings.tracker_term WHERE org_id = $1', [orgId]);
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

  // A meeting recorded by `rec` and read by `lan` and `nam` (held on Wednesday 25 November 2026, Vietnam time, unless a start is given).
  async function meeting(title: string, readers: string[] = ['lan', 'nam'], startedSql = "'2026-11-25T03:00:00Z'", endedSql = "'2026-11-25T04:00:00Z'"): Promise<string> {
    const id = randomUUID();
    await sqlAdmin(
      `INSERT INTO ludy_meetings.meeting (org_id, id, title, language, started_at, ended_at, length_seconds, recorder_user_id, visibility, status, consent_method, consent_confirmed_by, consent_confirmed_at, consent_notice_version, audio_retention_date, text_retention_date)
       VALUES ($1, $2, $4, 'vi', ${startedSql}, ${endedSql}, 3600, $3, 'attendees', 'ready', 'told_at_start', $3, now(), '1.0', current_date - 1, current_date + 365)`,
      [orgId, id, users.rec, title],
    );
    for (const reader of readers) await sqlAdmin('INSERT INTO ludy_meetings.meeting_reader (org_id, id, meeting_id, user_id) VALUES ($1, $2, $3, $4)', [orgId, randomUUID(), id, users[reader]]);
    return id;
  }
  const say = (meetingId: string, seconds: number, text: string, stage: 'draft' | 'published' = 'draft') =>
    sqlAdmin(`INSERT INTO ludy_meetings.transcript_segment (org_id, meeting_id, start_seconds, end_seconds, speaker_label, text, stage) VALUES ($1, $2, $3::numeric, $3::numeric + 5, 'Người nói 1', $4, $5::text)`, [orgId, meetingId, seconds, text, stage]);
  beforeAll(async () => {
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { ludy_app: 'test-app-pw', ludy_worker: 'test-worker-pw' });
    const url = new URL(adminUrl);
    url.username = 'ludy_app';
    url.password = 'test-app-pw';
    const appPool = createPool({ connectionString: url.toString(), max: 4 });
    pools.push(appPool);
    const db = createDb(appPool);
    runtime = new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands, ...meetingsCommands], queries: [...kernelQueries({ inboundDomain: null }), ...meetingsQueries] });
    for (const key of Object.keys(NAMES)) users[key] = await upsertIdentity(db, { issuer: 'trk', subject: key, email: `${key}@trk.test`, name: NAMES[key] as string });
    orgId = (await createOrg(runtime, asUser('owner'), 'Công ty Từ Khóa')).orgId;
    await sqlAdmin(`INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member'), ($1, $4, 'member'), ($1, $5, 'member'), ($1, $6, 'admin')`, [orgId, users.rec, users.lan, users.nam, users.other, users.adm]);
  }, 300_000);

  afterAll(async () => {
    await Promise.all(pools.map((p) => p.end()));
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('an owner or admin keeps the words, every member reads them, nobody else writes; a word is one row whatever its case', async () => {
    await clearTerms();
    const giaTerm = await add('owner', 'giá');
    await add('adm', 'Đối thủ Đại Việt');
    await expect(add('rec', 'hợp đồng')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(add('owner', 'GIÁ')).rejects.toMatchObject({ code: 'TRACKER_TERM_TAKEN' });
    // A term is judged by the glossary's rules: an address, a run of digits and a word with no letter are refused.
    for (const bad of ['gui@example.com', 'www.doithu.vn', '0912345678', '!!!']) await expect(add('owner', bad), bad).rejects.toThrow();
    for (const who of ['owner', 'adm', 'rec', 'lan', 'other']) expect(await terms(who), who).toEqual(['giá', 'Đối thủ Đại Việt'].sort());
    await expect(remove('lan', giaTerm.termId)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await remove('adm', giaTerm.termId)).toEqual({ termId: giaTerm.termId });
    expect(await terms('lan')).toEqual(['Đối thủ Đại Việt']);
    await expect(remove('owner', giaTerm.termId)).rejects.toMatchObject({ code: 'TRACKER_TERM_NOT_FOUND' });
  });

  it('keeps at most 20 words an org, and the limit does not hold up a remove', async () => {
    await clearTerms();
    for (let i = 0; i < TRACKER_TERMS_MAX; i++) await add('owner', `từ khóa số ${String.fromCharCode(97 + i)}`);
    await expect(add('owner', 'từ khóa thứ hai mươi mốt')).rejects.toMatchObject({ code: 'TRACKER_MAX' });
    const first = (await ask<TrackerTerms>('meetings.tracker.list', 'owner', {})).terms[0];
    await remove('owner', first?.id as string);
    expect((await add('owner', 'từ khóa thứ hai mươi mốt')).termId).toBeTruthy();
  }, 120_000);

  it('counts a word in a meeting and lists the seconds of the lines, from the lines the caller reads', async () => {
    await clearTerms();
    await add('owner', 'giá');
    await add('owner', 'hợp đồng');
    await add('owner', 'Đại Việt');
    const id = await meeting('Họp bán hàng');
    await say(id, 5, 'Chào mọi người', 'published');
    await say(id, 12.4, 'Giá bên Đại Việt thấp hơn, giá của mình cao', 'published');
    await say(id, 12.9, 'Giảm giá được không', 'published');
    await say(id, 40, 'Ký hợp đồng trước thứ Sáu, hợp đồng mẫu gửi sau', 'published');
    await say(id, 90, 'Chỉ nhắc đến giám đốc', 'published');
    const seen = await hits('lan', id);
    expect(seen.tracked).toBe(3);
    expect(seen.hits.map((h) => [h.term, h.count, h.seconds, h.more]).sort()).toEqual(
      [
        ['giá', 3, [12], false],
        ['hợp đồng', 2, [40], false],
        ['Đại Việt', 1, [12], false],
      ].sort(),
    );
    // A word nobody said is not listed, and a meeting with no tracked word at all answers with none.
    await clearTerms();
    expect(await hits('lan', id)).toEqual({ meetingId: id, tracked: 0, hits: [] });
  });

  it('a reader counts the published lines, the recorder the draft they are working on', async () => {
    await clearTerms();
    await add('owner', 'giá');
    const id = await meeting('Họp có bản nháp');
    await say(id, 10, 'Giá đã đăng', 'published');
    await say(id, 20, 'Giá nháp một, giá nháp hai', 'draft');
    expect((await hits('lan', id)).hits.map((h) => [h.count, h.seconds])).toEqual([[1, [10]]]);
    expect((await hits('rec', id)).hits.map((h) => [h.count, h.seconds])).toEqual([[2, [20]]]);
  });

  it('lists at most 20 seconds a word and says when there were more', async () => {
    await clearTerms();
    await add('owner', 'giá');
    const id = await meeting('Họp nói giá mãi');
    for (let s = 0; s < 25; s++) await say(id, s * 10, `Giá lần ${s}`, 'published');
    const [hit] = (await hits('lan', id)).hits;
    expect(hit).toMatchObject({ count: 25, more: true });
    expect(hit?.seconds).toHaveLength(20);
    expect(hit?.seconds[0]).toBe(0);
  });

  it('a member who cannot read the meeting finds no meeting, and an owner has no extra right to it', async () => {
    await clearTerms();
    await add('owner', 'giá');
    const id = await meeting('Họp riêng của nhóm');
    await say(id, 10, 'Giá rất riêng', 'published');
    for (const who of ['other', 'owner', 'adm']) await expect(hits(who, id), who).rejects.toMatchObject({ code: 'MEETING_NOT_FOUND' });
  });

  it('a week counts the meetings the caller reads and lists the busiest first, never one they cannot read', async () => {
    await clearTerms();
    // The meetings of the earlier tests may fall in this week too: start from none.
    await sqlAdmin('DELETE FROM ludy_meetings.meeting WHERE org_id = $1', [orgId]);
    await add('owner', 'giá');
    await add('owner', 'hợp đồng');
    const now = ["now() - interval '1 minute'", 'now()'] as const;
    const a = await meeting('Họp A', ['lan'], ...now);
    const b = await meeting('Họp B', ['lan'], ...now);
    const hidden = await meeting('Họp riêng', ['nam'], ...now);
    for (const [id, text] of [[a, 'Giá, giá và giá'], [b, 'Giá một lần, hợp đồng một lần'], [hidden, 'Giá giá giá giá giá giá riêng tư']] as const) await say(id, 10, text, 'published');
    const seen = await week('lan');
    expect(seen).toMatchObject({ tracked: 2, meetings: 2, cut: false });
    expect(seen.terms.map((t) => [t.term, t.count, t.meetings.map((m) => [m.title, m.count]), t.moreMeetings])).toEqual([
      ['giá', 4, [['Họp A', 3], ['Họp B', 1]], 0],
      ['hợp đồng', 1, [['Họp B', 1]], 0],
    ]);
    // The reader of the other meeting counts that one and not the first two.
    expect((await week('nam')).terms.map((t) => [t.term, t.count])).toEqual([['giá', 6]]);
    // An owner who reads none of them counts none (no extra right), and a week with no meeting is empty.
    expect(await week('owner')).toMatchObject({ meetings: 0, terms: [] });
    expect(await week('lan', 5)).toMatchObject({ meetings: 0, terms: [] });
  });

  it('the audit rows hold ids and counts, never a word or a line', async () => {
    await clearTerms();
    const made = await add('owner', 'từ khóa kiểm toán riêng');
    const id = await meeting('Họp kiểm toán từ khóa');
    await say(id, 10, 'Nói từ khóa kiểm toán riêng trong họp', 'published');
    await hits('lan', id);
    await week('lan');
    await remove('owner', made.termId);
    const audit = await sqlAdmin<{ row: string }>(`SELECT audit_event::text AS row FROM ludy_kernel.audit_event WHERE org_id = $1 AND audit_event::text LIKE '%meetings.tracker.%'`, [orgId]);
    expect(audit.rows.length).toBeGreaterThanOrEqual(4);
    const text = audit.rows.map((r) => r.row).join('\n');
    for (const secret of ['kiểm toán riêng', 'Nói từ khóa']) expect(text, secret).not.toContain(secret);
    expect(text).toContain('termCount');
  });
});

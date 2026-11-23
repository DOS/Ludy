// SPDX-License-Identifier: AGPL-3.0-only
// The recorder's Vy writing the chapters of a meeting, on a real database (#3844, step 3): the run starts for the recorder alone, its result is private, the copy into the draft is the recorder's own click
// and is born tainted (the model's text), anchors are checked again at the copy, a second copy of a run is refused, only the review clears the mark and only then can the chapters be published, a save never
// clears it, a meeting's removal cancels a run in flight, and a title holds none of the characters the minutes templates refuse (#3882), in the command and in the database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Chapters } from '@ludy/kernel-contract';
import { createDb, createPool } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import { Runtime } from '@ludy/kernel-runtime';
import { meetingsCommands, meetingsQueries, setSummaryEnabled } from '@ludy/mod-meetings';
import { TEST_MANIFESTS } from './invariant/fixtures/manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('the recorder\'s Vy chapters of a meeting (#3844, step 3)', () => {
  const dbName = `crove_test_chapters_run_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  const pools: pg.Pool[] = [];
  let orgId = '';
  let runtime: Runtime;
  const users: Record<string, string> = {};
  const asUser = (who: string) => ({ type: 'user' as const, userId: users[who] as string, aal: 'aal1' as const });
  const exec = <O = unknown>(who: string, name: string, input: unknown) => runtime.execute<O>(name, input, { actor: asUser(who), orgId });
  const query = <O = unknown>(who: string, name: string, input: unknown) => runtime.query<O>(name, input, { actor: asUser(who), orgId });
  const refuses = (promise: Promise<unknown>) => promise.then(() => null, (error: unknown) => (error as { code?: string }).code ?? 'ERR');
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
  const rowsOf = (meetingId: string, stage?: string) =>
    sqlAdmin<{ position: number; title: string; start_seconds: number; stage: string; tainted: boolean }>(
      `SELECT position, title, start_seconds, stage, tainted FROM ludy_meetings.meeting_chapter WHERE org_id = $1 AND meeting_id = $2 AND ($3::text IS NULL OR stage = $3) ORDER BY stage, position`,
      [orgId, meetingId, stage ?? null],
    ).then((r) => r.rows);

  // Lines start at 0, 10, 20 and 300 seconds.
  async function seedMeeting(recorder: string, readers: string[] = ['reader']): Promise<string> {
    const meetingId = randomUUID();
    await sqlAdmin(
      `INSERT INTO ludy_meetings.meeting (org_id, id, title, language, started_at, ended_at, length_seconds, recorder_user_id, visibility, status, consent_method, consent_confirmed_by, consent_confirmed_at, consent_notice_version, audio_retention_date, text_retention_date)
       VALUES ($1, $2, 'Họp tuần', 'vi', '2026-11-10T03:00:00Z', '2026-11-10T04:00:00Z', 3600, $3, 'attendees', 'ready', 'told_at_start', $3, now(), '1.0', current_date + 30, current_date + 365)`,
      [orgId, meetingId, users[recorder]],
    );
    for (const reader of readers) await sqlAdmin(`INSERT INTO ludy_meetings.meeting_reader (org_id, id, meeting_id, user_id) VALUES ($1, $2, $3, $4)`, [orgId, randomUUID(), meetingId, users[reader]]);
    await exec(recorder, 'meetings.transcript.draft_store', {
      meetingId,
      segments: [
        { startSeconds: 0, endSeconds: 10, speakerLabel: 'Hà', text: 'Chào mọi người' },
        { startSeconds: 10, endSeconds: 20, speakerLabel: 'Hà', text: 'Bàn về báo giá' },
        { startSeconds: 20, endSeconds: 30, speakerLabel: 'Nam', text: 'Chiết khấu tháng này' },
        { startSeconds: 300, endSeconds: 310, speakerLabel: 'Nam', text: 'Kế hoạch giao hàng' },
      ],
    });
    return meetingId;
  }
  const save = (who: string, meetingId: string, chapters: Array<{ title: string; startSeconds: number }>) => exec<{ meetingId: string; chapters: number }>(who, 'meetings.chapters.save', { meetingId, chapters });
  const get = (who: string, meetingId: string) => query<Chapters>(who, 'meetings.chapters.get', { meetingId });
  const titles = (list: Array<{ title: string }>) => list.map((c) => c.title);

  beforeAll(async () => {
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { ludy_app: 'test-app-pw' });
    const url = new URL(adminUrl);
    url.username = 'ludy_app';
    url.password = 'test-app-pw';
    appUrl = url.toString();
    const pool = createPool({ connectionString: appUrl, max: 4 });
    pools.push(pool);
    runtime = new Runtime(createDb(pool), { manifests: TEST_MANIFESTS }).register({
      commands: [...kernelCommands, ...meetingsCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...meetingsQueries],
    });
    setSummaryEnabled(true);
    for (const key of ['owner', 'recorder', 'reader', 'stranger']) users[key] = await upsertIdentity(createDb(pool), { issuer: 'chapters', subject: key, email: `${key}@chapters.test`, name: null });
    orgId = (await createOrg(runtime, asUser('owner'), 'Mục lục')).orgId;
    await sqlAdmin(`INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member'), ($1, $4, 'member')`, [orgId, users.recorder, users.reader, users.stranger]);
  }, 300_000);

  afterAll(async () => {
    setSummaryEnabled(false);
    for (const pool of pools) await pool.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  // A finished run of `who`'s Vy for the meeting, its result stored as the route stores it.
  async function finishedRun(who: string, meetingId: string, body: unknown, feature = 'meetings.chapters'): Promise<string> {
    const started = await exec<{ runId: string }>(who, 'kernel.member_vy.run.start', { feature, subjectType: 'meeting', subjectId: meetingId });
    await exec(who, 'kernel.member_vy.result.store', { runId: started.runId, outcome: { status: 'ready', body: typeof body === 'string' ? body : JSON.stringify(body) } });
    return started.runId;
  }
  const BODY = { chapters: [{ title: 'Mở đầu', startSeconds: 0 }, { title: 'Báo giá', startSeconds: 10 }, { title: 'Giao hàng', startSeconds: 300 }], dropped: 1 };

  it('starts a run for the recorder alone, with the switch on and a transcript to read', async () => {
    const meetingId = await seedMeeting('recorder');
    expect(await query('recorder', 'meetings.chapters.status', { meetingId })).toEqual({ meetingId, enabled: true, reason: null });
    expect(await query('reader', 'meetings.chapters.status', { meetingId })).toEqual({ meetingId, enabled: false, reason: 'not_recorder' });
    expect(await refuses(exec('reader', 'meetings.chapters.start', { meetingId }))).toBe('FORBIDDEN');
    expect(await refuses(exec('stranger', 'meetings.chapters.start', { meetingId }))).not.toBeNull();
    const started = await exec<{ meetingId: string; runId: string }>('recorder', 'meetings.chapters.start', { meetingId });
    const run = await sqlAdmin<{ feature: string; subject_type: string; subject_id: string }>(`SELECT feature, subject_type, subject_id FROM ludy_kernel.member_vy_result WHERE org_id = $1 AND run_id = $2`, [orgId, started.runId]);
    expect(run.rows[0]).toMatchObject({ feature: 'meetings.chapters', subject_type: 'meeting', subject_id: meetingId });
    // A meeting with no transcript has nothing to write chapters from.
    const empty = await seedMeeting('recorder');
    await sqlAdmin(`DELETE FROM ludy_meetings.transcript_segment WHERE org_id = $1 AND meeting_id = $2`, [orgId, empty]);
    expect(await refuses(exec('recorder', 'meetings.chapters.start', { meetingId: empty }))).toBe('TRANSCRIPT_EMPTY');
    setSummaryEnabled(false);
    try {
      expect(await query('recorder', 'meetings.chapters.status', { meetingId })).toMatchObject({ enabled: false, reason: 'off' });
      expect(await refuses(exec('recorder', 'meetings.chapters.start', { meetingId }))).toBe('SUMMARY_OFF');
      const runId = await finishedRun('recorder', meetingId, BODY);
      expect(await refuses(exec('recorder', 'meetings.chapters.copy_result', { meetingId, runId }))).toBe('SUMMARY_OFF');
    } finally {
      setSummaryEnabled(true);
    }
  });

  it('copies a finished run into a tainted draft that only the recorder reads, and refuses a second copy of the run', async () => {
    const meetingId = await seedMeeting('recorder');
    const runId = await finishedRun('recorder', meetingId, BODY);
    expect(await exec('recorder', 'meetings.chapters.copy_result', { meetingId, runId })).toEqual({ meetingId, chapters: 3, dropped: 1 });
    const view = await get('recorder', meetingId);
    expect(view.draft.map((c) => [c.position, c.title, c.startSeconds, c.tainted])).toEqual([[1, 'Mở đầu', 0, true], [2, 'Báo giá', 10, true], [3, 'Giao hàng', 300, true]]);
    expect((await sqlAdmin<{ source_run_id: string }>(`SELECT source_run_id FROM ludy_meetings.meeting_chapter WHERE meeting_id = $1`, [meetingId])).rows.every((r) => r.source_run_id === runId)).toBe(true);
    expect(await get('reader', meetingId)).toEqual({ meetingId, draft: [], published: [] });
    expect(await refuses(exec('recorder', 'meetings.chapters.copy_result', { meetingId, runId }))).toBe('CHAPTERS_ALREADY_COPIED');
    // The audit row of the copy holds counts, no title.
    const audit = await sqlAdmin<{ detail: unknown }>(`SELECT detail FROM ludy_kernel.audit_event WHERE org_id = $1 AND command = 'meetings.chapters.copy_result' ORDER BY id DESC LIMIT 1`, [orgId]);
    expect(JSON.stringify(audit.rows[0]?.detail)).not.toContain('Báo giá');
  });

  it('copies only a finished chapters run of this very meeting, for the recorder, and reads the body strictly', async () => {
    const meetingId = await seedMeeting('recorder');
    const other = await seedMeeting('recorder');
    const runId = await finishedRun('recorder', meetingId, BODY);
    expect(await refuses(exec('reader', 'meetings.chapters.copy_result', { meetingId, runId }))).toBe('FORBIDDEN');
    expect(await refuses(exec('recorder', 'meetings.chapters.copy_result', { meetingId: other, runId }))).toBe('SUMMARY_RESULT_NOT_FOUND');
    // A summary run and a run not finished are not chapters of this meeting.
    const summaryRun = await finishedRun('recorder', meetingId, { summary: 'Họp.', decisions: [], items: [], dropped: 0 }, 'meetings.summary');
    expect(await refuses(exec('recorder', 'meetings.chapters.copy_result', { meetingId, runId: summaryRun }))).toBe('SUMMARY_RESULT_NOT_FOUND');
    const open = (await exec<{ runId: string }>('recorder', 'kernel.member_vy.run.start', { feature: 'meetings.chapters', subjectType: 'meeting', subjectId: meetingId })).runId;
    expect(await refuses(exec('recorder', 'meetings.chapters.copy_result', { meetingId, runId: open }))).toBe('SUMMARY_RESULT_NOT_READY');
    // A body of another shape, or one with a title that is not allowed, is refused and nothing is written.
    for (const body of ['not json', { chapters: [], dropped: 0 }, { chapters: [{ title: 'x', startSeconds: 1.5 }], dropped: 0 }, { chapters: [{ title: 'x', startSeconds: 0, extra: 1 }], dropped: 0 }, { chapters: Array.from({ length: 21 }, (_, i) => ({ title: `t${i}`, startSeconds: i })), dropped: 0 }]) {
      const bad = await finishedRun('recorder', meetingId, body);
      expect(await refuses(exec('recorder', 'meetings.chapters.copy_result', { meetingId, runId: bad })), JSON.stringify(body).slice(0, 40)).toBe('SUMMARY_RESULT_INVALID');
    }
    expect(await rowsOf(meetingId)).toEqual([]);
  });

  it('checks the anchors again at the copy: a line gone since the run drops its chapter, none left is refused', async () => {
    const meetingId = await seedMeeting('recorder');
    const runId = await finishedRun('recorder', meetingId, { chapters: [{ title: 'Mở đầu', startSeconds: 0 }, { title: 'Giữa dòng', startSeconds: 5 }, { title: 'Giao hàng', startSeconds: 300 }], dropped: 0 });
    // The run named 5, which no line starts at (as if the line had been replaced since); a title with an email, written past the model checks, is dropped too.
    const second = await finishedRun('recorder', meetingId, { chapters: [{ title: 'Gửi an@x.example', startSeconds: 20 }, { title: 'Báo giá', startSeconds: 10 }], dropped: 0 });
    expect(await exec('recorder', 'meetings.chapters.copy_result', { meetingId, runId })).toEqual({ meetingId, chapters: 2, dropped: 1 });
    expect(titles((await get('recorder', meetingId)).draft)).toEqual(['Mở đầu', 'Giao hàng']);
    // A new run replaces the model-written draft.
    expect(await exec('recorder', 'meetings.chapters.copy_result', { meetingId, runId: second })).toEqual({ meetingId, chapters: 1, dropped: 1 });
    expect(titles((await get('recorder', meetingId)).draft)).toEqual(['Báo giá']);
    const stale = await finishedRun('recorder', meetingId, { chapters: [{ title: 'Giữa dòng', startSeconds: 7 }], dropped: 0 });
    expect(await refuses(exec('recorder', 'meetings.chapters.copy_result', { meetingId, runId: stale }))).toBe('CHAPTERS_STALE');
    expect(titles((await get('recorder', meetingId)).draft)).toEqual(['Báo giá']);
  });

  it('does not overwrite a draft the recorder typed or read: the copy is refused and nothing changes', async () => {
    const meetingId = await seedMeeting('recorder');
    await save('recorder', meetingId, [{ title: 'Của tôi', startSeconds: 0 }]);
    const runId = await finishedRun('recorder', meetingId, BODY);
    expect(await refuses(exec('recorder', 'meetings.chapters.copy_result', { meetingId, runId }))).toBe('DRAFT_CHAPTERS_EXIST');
    expect((await rowsOf(meetingId)).map((r) => [r.title, r.tainted])).toEqual([['Của tôi', false]]);
    // Cleared by the recorder, the copy goes through.
    await save('recorder', meetingId, []);
    expect(await exec('recorder', 'meetings.chapters.copy_result', { meetingId, runId })).toMatchObject({ chapters: 3 });
  });

  it('keeps the mark through a save, clears it only by the review, and only then publishes', async () => {
    const meetingId = await seedMeeting('recorder');
    const runId = await finishedRun('recorder', meetingId, BODY);
    await exec('recorder', 'meetings.chapters.copy_result', { meetingId, runId });
    expect(await refuses(exec('recorder', 'meetings.result.publish', { meetingId, confirmed: true }))).toBe('DRAFT_NOT_REVIEWED');
    // The recorder edits one title and adds a chapter of their own: the edited one keeps the mark (the same second), the new one is theirs.
    await save('recorder', meetingId, [{ title: 'Mở đầu, sửa', startSeconds: 0 }, { title: 'Báo giá', startSeconds: 10 }, { title: 'Chiết khấu', startSeconds: 20 }]);
    expect((await rowsOf(meetingId, 'draft')).map((r) => [r.title, r.tainted])).toEqual([['Mở đầu, sửa', true], ['Báo giá', true], ['Chiết khấu', false]]);
    expect((await sqlAdmin<{ n: number }>(`SELECT count(*)::int AS n FROM ludy_meetings.meeting_chapter WHERE meeting_id = $1 AND source_run_id = $2`, [meetingId, runId])).rows[0]?.n).toBe(2);
    expect(await refuses(exec('recorder', 'meetings.result.publish', { meetingId, confirmed: true }))).toBe('DRAFT_NOT_REVIEWED');
    // Another meeting's recorder cannot review these rows, and a stranger neither.
    const draft = (await get('recorder', meetingId)).draft;
    const foreign = await seedMeeting('recorder');
    expect(await refuses(exec('recorder', 'meetings.draft.review', { meetingId: foreign, confirmed: true, ids: draft.map((c) => c.id) }))).not.toBeNull();
    expect(await refuses(exec('reader', 'meetings.draft.review', { meetingId, confirmed: true, ids: draft.map((c) => c.id) }))).toBe('FORBIDDEN');
    expect((await rowsOf(meetingId, 'draft')).filter((r) => r.tainted)).toHaveLength(2);
    // The recorder's review of the rows on screen clears the mark; then the publish goes through and the readers read the set.
    expect(await exec('recorder', 'meetings.draft.review', { meetingId, confirmed: true, ids: draft.map((c) => c.id) })).toEqual({ meetingId, cleared: 2 });
    expect(await exec('recorder', 'meetings.result.publish', { meetingId, confirmed: true })).toMatchObject({ chapters: 3 });
    expect(titles((await get('reader', meetingId)).published)).toEqual(['Mở đầu, sửa', 'Báo giá', 'Chiết khấu']);
    expect((await get('reader', meetingId)).published.every((c) => c.tainted === false)).toBe(true);
  });

  it('keeps the mark when a chapter Vy wrote is moved to another line or only its title is changed, and a chapter of the recorder\'s own stays clean', async () => {
    const meetingId = await seedMeeting('recorder');
    const runId = await finishedRun('recorder', meetingId, { chapters: [{ title: 'Mở đầu', startSeconds: 0 }, { title: 'Báo giá', startSeconds: 10 }], dropped: 0 });
    await exec('recorder', 'meetings.chapters.copy_result', { meetingId, runId });
    // Only the line changes (10 to 20): the title is still the model's.
    await save('recorder', meetingId, [{ title: 'Mở đầu', startSeconds: 0 }, { title: 'Báo giá', startSeconds: 20 }]);
    expect((await rowsOf(meetingId, 'draft')).map((r) => [r.title, r.start_seconds, r.tainted])).toEqual([['Mở đầu', 0, true], ['Báo giá', 20, true]]);
    expect(await refuses(exec('recorder', 'meetings.result.publish', { meetingId, confirmed: true }))).toBe('DRAFT_NOT_REVIEWED');
    // Only the title changes: the line is still the model's.
    await save('recorder', meetingId, [{ title: 'Mở đầu', startSeconds: 0 }, { title: 'Báo giá khách A', startSeconds: 20 }]);
    expect((await rowsOf(meetingId, 'draft')).every((r) => r.tainted)).toBe(true);
    // Both changed, at a line and with a title that are the recorder's own: theirs, clean.
    await save('recorder', meetingId, [{ title: 'Mở đầu', startSeconds: 0 }, { title: 'Giao hàng', startSeconds: 300 }]);
    expect((await rowsOf(meetingId, 'draft')).map((r) => [r.title, r.tainted])).toEqual([['Mở đầu', true], ['Giao hàng', false]]);
    expect((await sqlAdmin<{ n: number }>(`SELECT count(*)::int AS n FROM ludy_meetings.meeting_chapter WHERE meeting_id = $1 AND source_run_id = $2`, [meetingId, runId])).rows[0]?.n).toBe(1);
  });

  it('refuses a title with a line or paragraph separator, a zero-width, bidi or control character, by the command and by the database (#3882)', async () => {
    const meetingId = await seedMeeting('recorder');
    for (const [title, code] of [
      ['dòng một\u2028dòng hai', 'CHAPTER_TITLE_MULTILINE'],
      ['dòng một\u2029dòng hai', 'CHAPTER_TITLE_MULTILINE'],
      ['ẩn\u200bký tự', 'CHAPTER_TITLE_CONTROL'],
      ['đảo\u202echiều', 'CHAPTER_TITLE_CONTROL'],
      ['cô lập\u2066bidi\u2069', 'CHAPTER_TITLE_CONTROL'],
      ['điều khiển\u0007', 'CHAPTER_TITLE_CONTROL'],
      ['b\ufeffom', 'CHAPTER_TITLE_CONTROL'],
      ['thẻ\u{e0041}', 'CHAPTER_TITLE_CONTROL'],
      ['đệm\u3164', 'CHAPTER_TITLE_CONTROL'],
      ['nửa\ud800cặp', 'CHAPTER_TITLE_CONTROL'],
    ] as const) {
      expect(await refuses(save('recorder', meetingId, [{ title, startSeconds: 0 }])), JSON.stringify(title)).toBe(code);
    }
    // Vietnamese text with combining marks and a Vietnamese tone mark in the middle of a word is fine.
    expect(await save('recorder', meetingId, [{ title: 'Tiếng Việt: quyết định', startSeconds: 0 }])).toMatchObject({ chapters: 1 });
    // The same class in the database, past the command: the same characters are refused, and the class matches the minutes templates' CHECK.
    for (const bad of ['a\u2028b', 'a\u2029b', 'a\u200bb', 'a\u202eb', 'a\u2066b', 'a\u0007b', 'a\ufeffb', 'a\u{e0041}b', 'a\u3164b', 'a\u00adb', 'a\u034fb']) {
      await expect(sqlAdmin(`INSERT INTO ludy_meetings.meeting_chapter (org_id, meeting_id, position, title, start_seconds) VALUES ($1, $2, 9, $3, 20)`, [orgId, meetingId, bad]), JSON.stringify(bad)).rejects.toMatchObject({ code: '23514' });
    }
    await expect(sqlAdmin(`UPDATE ludy_meetings.meeting_chapter SET title = $2 WHERE meeting_id = $1`, [meetingId, 'a\u2028b'])).rejects.toMatchObject({ code: '23514' });
    expect(titles(await rowsOf(meetingId))).toEqual(['Tiếng Việt: quyết định']);
  });

  it('cancels a run in flight when the meeting is removed, and deletes a finished private result with it', async () => {
    const meetingId = await seedMeeting('recorder');
    // One live run per feature for a member: the finished run comes first, so the one in flight is not superseded by it.
    const other = await seedMeeting('recorder');
    const done = await finishedRun('recorder', other, BODY);
    const { runId } = await exec<{ runId: string }>('recorder', 'meetings.chapters.start', { meetingId });
    const results = (id: string) => sqlAdmin<{ n: number }>(`SELECT count(*)::int AS n FROM ludy_kernel.member_vy_result WHERE org_id = $1 AND subject_id = $2`, [orgId, id]).then((r) => r.rows[0]?.n);
    expect(await results(meetingId)).toBe(1);
    expect(await results(other)).toBe(1);
    await sqlAdmin(`DELETE FROM ludy_meetings.meeting WHERE org_id = $1 AND id = ANY($2::uuid[])`, [orgId, [meetingId, other]]);
    expect(await results(meetingId)).toBe(0);
    expect(await results(other)).toBe(0);
    const runs = await sqlAdmin<{ id: string; status: string; error: string | null }>(`SELECT id, status, error FROM ludy_kernel.ai_run WHERE org_id = $1 AND id = ANY($2::uuid[])`, [orgId, [runId, done]]);
    expect(runs.rows.find((r) => r.id === runId)).toMatchObject({ status: 'cancelled', error: 'MEETING_REMOVED' });
    const audit = await sqlAdmin<{ n: number }>(`SELECT count(*)::int AS n FROM ludy_kernel.audit_event WHERE org_id = $1 AND command = 'meetings.vy.run_cancelled' AND detail->>'feature' = 'meetings.chapters'`, [orgId]);
    expect(audit.rows[0]?.n).toBe(1);
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
// Spoken cues to Vy (#4807) on a real database: the recorder's click drafts one item for each cue in the transcript, found by code; the item is a draft, tainted, flagged 'asked_aloud' (so it is never clean),
// cites the cue's second, and takes its owner and date from the same code as the summary's items; only the recorder may click; a second click adds nothing for a line that has an item; the recorder's draft is
// read before published lines; the item limit holds; and the audit row holds counts, never text.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import { ITEMS_PER_MEETING_MAX, type MeetingResults, type VoiceCueDrafted } from '@ludy/kernel-contract';
import { Runtime } from '@ludy/kernel-runtime';
import { meetingsCommands, meetingsQueries } from '@ludy/mod-meetings';
import { TEST_MANIFESTS } from './invariant/fixtures/manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('Spoken cues to Vy (#4807)', () => {
  const dbName = `ludy_test_voice_cue_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  const pools: pg.Pool[] = [];
  let orgId = '';
  let runtime: Runtime;
  const users: Record<string, string> = {};
  const NAMES: Record<string, string> = { owner: 'Chủ Công Ty', rec: 'Phạm Quang Minh', lan: 'Trần Thị Lan', nam: 'Nguyễn Văn Nam', other: 'Bạn Không Đọc' };
  const asUser = (who: string) => ({ type: 'user' as const, userId: users[who] as string, aal: 'aal1' as const });
  const draftCues = (who: string, meetingId: string) => runtime.execute<VoiceCueDrafted>('meetings.voice_cue.draft', { meetingId }, { actor: asUser(who), orgId });
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

  // A meeting held on Wednesday 25 November 2026 (Vietnam time), recorded by `rec` and read by `lan` and `nam`.
  async function meeting(title: string, readers: string[] = ['lan', 'nam']): Promise<string> {
    const id = randomUUID();
    await sqlAdmin(
      `INSERT INTO ludy_meetings.meeting (org_id, id, title, language, started_at, ended_at, length_seconds, recorder_user_id, visibility, status, consent_method, consent_confirmed_by, consent_confirmed_at, consent_notice_version, audio_retention_date, text_retention_date)
       VALUES ($1, $2, $4, 'vi', '2026-11-25T03:00:00Z', '2026-11-25T04:00:00Z', 3600, $3, 'attendees', 'ready', 'told_at_start', $3, now(), '1.0', current_date - 1, current_date + 365)`,
      [orgId, id, users.rec, title],
    );
    for (const reader of readers) await sqlAdmin('INSERT INTO ludy_meetings.meeting_reader (org_id, id, meeting_id, user_id) VALUES ($1, $2, $3, $4)', [orgId, randomUUID(), id, users[reader]]);
    return id;
  }
  const say = (meetingId: string, seconds: number, text: string, stage: 'draft' | 'published' = 'draft') =>
    sqlAdmin(`INSERT INTO ludy_meetings.transcript_segment (org_id, meeting_id, start_seconds, end_seconds, speaker_label, text, stage) VALUES ($1, $2, $3, $3 + 5, 'Người nói 1', $4, $5)`, [orgId, meetingId, seconds, text, stage]);
  const items = (meetingId: string) =>
    sqlAdmin<{ title: string; who_drafted: string; who_parsed: string | null; when_drafted: string; when_parsed: string | null; transcript_seconds: number | null; stage: string; status: string; tainted: boolean; flags: string[]; source_run_id: string | null }>(
      `SELECT title, who_drafted, who_parsed, when_drafted, when_parsed::text, transcript_seconds, stage, status, tainted, flags, source_run_id FROM ludy_meetings.action_item WHERE org_id = $1 AND meeting_id = $2 ORDER BY transcript_seconds, created_at`,
      [orgId, meetingId],
    ).then((r) => r.rows);

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
    for (const key of Object.keys(NAMES)) users[key] = await upsertIdentity(db, { issuer: 'cue', subject: key, email: `${key}@cue.test`, name: NAMES[key] as string });
    orgId = (await createOrg(runtime, asUser('owner'), 'Công ty Lệnh Nói')).orgId;
    await sqlAdmin(`INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member'), ($1, $4, 'member'), ($1, $5, 'member')`, [orgId, users.rec, users.lan, users.nam, users.other]);
  }, 300_000);

  afterAll(async () => {
    await Promise.all(pools.map((p) => p.end()));
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('drafts one marked item for each cue, with the owner, the date and the second of the line', async () => {
    const id = await meeting('Họp giao ban');
    await say(id, 5, 'Chào mọi người, bắt đầu họp.');
    await say(id, 62.8, 'Vy ơi, ghi lại việc gửi báo giá cho anh Nam, hạn thứ Sáu');
    await say(id, 130, 'Cần soạn hợp đồng với khách Á Châu');
    await say(id, 141, 'Vy ơi, ghi lại việc này cho chị Lan, trước ngày mai');
    await say(id, 200, 'Vy, remind us to call the supplier');
    // Nothing to write down, and the line before is a cue itself: skipped and counted.
    await say(id, 230, 'Vy ơi, ghi lại việc này');
    await say(id, 260, 'Anh Vy ghi lại biên bản giúp tôi');

    const result = await draftCues('rec', id);
    expect(result).toEqual({ meetingId: id, found: 4, created: 3, duplicate: 0, empty: 1, full: 0 });
    const rows = await items(id);
    expect(rows.map((r) => [r.transcript_seconds, r.title])).toEqual([
      [62, 'việc gửi báo giá'],
      [141, 'Cần soạn hợp đồng với khách Á Châu'],
      [200, 'call the supplier'],
    ]);
    expect(rows[0]).toMatchObject({ who_drafted: 'anh Nam', who_parsed: users.nam, when_drafted: 'thứ Sáu', when_parsed: '2026-11-27' });
    expect(rows[1]).toMatchObject({ who_drafted: 'chị Lan', who_parsed: users.lan, when_drafted: 'ngày mai', when_parsed: '2026-11-26' });
    expect(rows[2]).toMatchObject({ who_drafted: '', who_parsed: null, when_drafted: '', when_parsed: null });
    for (const row of rows) expect(row).toMatchObject({ stage: 'draft', status: 'suggested', tainted: true, source_run_id: null, flags: ['asked_aloud'] });
  });

  it('is never "clean", so the bulk accept leaves it for the recorder to confirm one by one', async () => {
    const id = await meeting('Họp có lệnh nói');
    await say(id, 30, 'Vy ơi, ghi lại gửi báo giá cho anh Nam, hạn thứ Sáu');
    await draftCues('rec', id);
    const view = await runtime.query<MeetingResults>('meetings.result.get', { meetingId: id }, { actor: asUser('rec'), orgId });
    expect(view.items).toHaveLength(1);
    expect(view.items[0]).toMatchObject({ flags: ['asked_aloud'], tainted: true, stage: 'draft', clean: false, whoUserId: users.nam, whenDate: '2026-11-27', transcriptSeconds: 30 });
    // Nothing is shared: a reader sees no published item and no draft.
    const reader = await runtime.query<MeetingResults>('meetings.result.get', { meetingId: id }, { actor: asUser('lan'), orgId });
    expect(reader.items).toEqual([]);
  });

  it('is only for the recorder: a reader is refused, a member who does not read the meeting meets a 404', async () => {
    const id = await meeting('Họp riêng');
    await say(id, 30, 'Vy ơi, ghi lại gửi báo giá');
    await expect(draftCues('lan', id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(draftCues('other', id)).rejects.toMatchObject({ code: 'MEETING_NOT_FOUND' });
    await expect(draftCues('owner', id)).rejects.toMatchObject({ code: 'MEETING_NOT_FOUND' });
    expect(await items(id)).toEqual([]);
  });

  it('adds nothing for a line that already has an item, and only the new cues the second time', async () => {
    const id = await meeting('Họp hai lần');
    await say(id, 30, 'Vy ơi, ghi lại gọi khách');
    expect(await draftCues('rec', id)).toMatchObject({ found: 1, created: 1, duplicate: 0 });
    expect(await draftCues('rec', id)).toMatchObject({ found: 1, created: 0, duplicate: 1 });
    await say(id, 90, 'Vy ơi, ghi lại gửi hợp đồng');
    expect(await draftCues('rec', id)).toMatchObject({ found: 2, created: 1, duplicate: 1 });
    expect((await items(id)).map((r) => r.title)).toEqual(['gọi khách', 'gửi hợp đồng']);
  });

  it('reads the recorder\'s draft lines, else the published ones, and finds nothing in a meeting with no transcript', async () => {
    const both = await meeting('Họp có nháp và bản chia sẻ');
    await say(both, 10, 'Vy ơi, ghi lại việc đã chia sẻ', 'published');
    await say(both, 20, 'Vy ơi, ghi lại việc trong bản nháp', 'draft');
    expect(await draftCues('rec', both)).toMatchObject({ found: 1, created: 1 });
    expect((await items(both)).map((r) => r.title)).toEqual(['việc trong bản nháp']);

    const published = await meeting('Họp chỉ có bản chia sẻ');
    await say(published, 10, 'Vy ơi, ghi lại việc đã chia sẻ', 'published');
    expect(await draftCues('rec', published)).toMatchObject({ found: 1, created: 1 });

    const silent = await meeting('Họp không có bản ghi lời');
    expect(await draftCues('rec', silent)).toEqual({ meetingId: silent, found: 0, created: 0, duplicate: 0, empty: 0, full: 0 });
  });

  it('keeps to the item limit of a meeting', async () => {
    const id = await meeting('Họp đầy việc');
    await sqlAdmin(
      `INSERT INTO ludy_meetings.action_item (org_id, meeting_id, title, who_drafted, when_drafted, stage, flags, tainted, transcript_seconds)
       SELECT $1, $2, 'Việc ' || n, '', '', 'draft', '[]'::jsonb, false, 1000 + n FROM generate_series(1, $3::int) AS n`,
      [orgId, id, ITEMS_PER_MEETING_MAX - 1],
    );
    await say(id, 10, 'Vy ơi, ghi lại việc thứ nhất');
    await say(id, 20, 'Vy ơi, ghi lại việc thứ hai');
    expect(await draftCues('rec', id)).toMatchObject({ found: 2, created: 1, full: 1 });
    expect((await items(id)).length).toBe(ITEMS_PER_MEETING_MAX);
  });

  it('leaves an audit row with counts and none of the text', async () => {
    const id = await meeting('Họp để kiểm toán');
    await say(id, 10, 'Vy ơi, ghi lại nội dung rất riêng của lệnh nói cho anh Nam');
    await draftCues('rec', id);
    const audit = await sqlAdmin<{ row: string }>(`SELECT audit_event::text AS row FROM ludy_kernel.audit_event WHERE org_id = $1 AND audit_event::text LIKE '%meetings.voice_cue.draft%' AND audit_event::text LIKE $2`, [orgId, `%${id}%`]);
    expect(audit.rows.length).toBeGreaterThan(0);
    const text = audit.rows.map((r) => r.row).join('\n');
    for (const secret of ['rất riêng', 'anh Nam', 'Họp để kiểm toán']) expect(text, secret).not.toContain(secret);
    expect(text).toContain('created');
  });
});

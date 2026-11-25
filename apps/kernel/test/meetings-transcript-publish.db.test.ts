// SPDX-License-Identifier: AGPL-3.0-only
// The recorder's publish shares the transcript lines (#4899, ADR-0047 point 3), on a real database. Until now nothing moved a line to `published`, so a reader who was not the recorder never read a line
// of any transcript. The sequence of the issue: the recorder stores a transcript, reads it, publishes; a reader of the meeting reads the lines through the transcript page, the file download and the
// search, a member who is not a reader (an owner of an attendees-only meeting) gets nothing; a later publish after a re-transcription replaces the lines; a line that is still the model's and unread
// refuses the publish, and the review of the transcript (the same "I read this" click) clears it. The tenant role still cannot set a line's stage or call the definer that does, but as the recorder.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MeetingSearchResult, Transcript, TranscriptExport } from '@ludy/kernel-contract';
import { createDb, createPool } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import { Runtime } from '@ludy/kernel-runtime';
import { meetingsCommands, meetingsQueries } from '@ludy/mod-meetings';
import { contextToken } from './invariant/fixtures/context-token.ts';
import { TEST_MANIFESTS } from './invariant/fixtures/manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

// A word that no log, audit row or file name may ever carry.
const CANARY = 'Zorbaxx';

suite('the recorder publishes the transcript lines with the minutes (#4899)', () => {
  const dbName = `ludy_test_transcript_publish_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let workerUrl = '';
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
  // Runs fn as the app's login role in a member's user context (the table's row policy and the function's own checks decide, not the commands), rolled back.
  async function asMember<T>(who: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: appUrl });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT ludy_kernel.enter_user_context($1::uuid, $2::text)', [orgId, contextToken(users[who] as string, orgId)]);
      return await fn(c);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      await c.end();
    }
  }
  const get = (who: string, meetingId: string) => query<Transcript>(who, 'meetings.transcript.get', { meetingId });
  const download = (who: string, meetingId: string) => query<TranscriptExport>(who, 'meetings.transcript.download', { meetingId, format: 'txt' });
  const search = (who: string, q: string) => query<MeetingSearchResult>(who, 'meetings.search', { q, limit: 20, offset: 0 });
  const publish = (who: string, meetingId: string) => exec<{ meetingId: string; results: number; items: number; chapters: number; lines: number }>(who, 'meetings.result.publish', { meetingId, confirmed: true });
  const stored = (meetingId: string, stage: string) =>
    sqlAdmin<{ text: string; tainted: boolean }>(`SELECT text, tainted FROM ludy_meetings.transcript_segment WHERE org_id = $1 AND meeting_id = $2 AND stage = $3 ORDER BY start_seconds`, [orgId, meetingId, stage]).then((r) => r.rows);
  const text = (file: TranscriptExport) => Buffer.from(file.contentBase64, 'base64').toString('utf8');

  // An attendees-only meeting of the recorder: `reader` may read it, the org's owner and `stranger` may not.
  async function seedMeeting(title: string, lines: Array<{ at: number; said: string }> = []): Promise<string> {
    const meetingId = randomUUID();
    await sqlAdmin(
      `INSERT INTO ludy_meetings.meeting (org_id, id, title, language, started_at, ended_at, length_seconds, recorder_user_id, visibility, status, consent_method, consent_confirmed_by, consent_confirmed_at, consent_notice_version, audio_retention_date, text_retention_date)
       VALUES ($1, $2, $3, 'vi', '2026-11-10T03:00:00Z', '2026-11-10T04:00:00Z', 3600, $4, 'attendees', 'ready', 'told_at_start', $4, now(), '1.0', current_date + 30, current_date + 365)`,
      [orgId, meetingId, title, users.recorder],
    );
    await sqlAdmin(`INSERT INTO ludy_meetings.meeting_reader (org_id, id, meeting_id, user_id) VALUES ($1, $2, $3, $4)`, [orgId, randomUUID(), meetingId, users.reader]);
    if (lines.length > 0) await store('recorder', meetingId, lines);
    return meetingId;
  }
  const store = (who: string, meetingId: string, lines: Array<{ at: number; said: string }>) =>
    exec(who, 'meetings.transcript.draft_store', { meetingId, segments: lines.map((l) => ({ startSeconds: l.at, endSeconds: l.at + 5, speakerLabel: 'Hà', text: l.said })) });
  const THREE = [
    { at: 0, said: `Chốt báo giá cho khách A ${CANARY}` },
    { at: 10, said: 'Giữ giá cũ đến cuối tháng' },
    { at: 20, said: 'Họp tiếp vào thứ sáu' },
  ];

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
    appUrl = url.toString();
    const worker = new URL(adminUrl);
    worker.username = 'ludy_worker';
    worker.password = 'test-worker-pw';
    workerUrl = worker.toString();
    const pool = createPool({ connectionString: appUrl, max: 4 });
    pools.push(pool);
    runtime = new Runtime(createDb(pool), { manifests: TEST_MANIFESTS }).register({
      commands: [...kernelCommands, ...meetingsCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...meetingsQueries],
    });
    for (const key of ['owner', 'recorder', 'reader', 'stranger']) users[key] = await upsertIdentity(createDb(pool), { issuer: 'transcript-publish', subject: key, email: `${key}@transcript-publish.test`, name: null });
    orgId = (await createOrg(runtime, asUser('owner'), 'Bản ghi chia sẻ')).orgId;
    await sqlAdmin(`INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member'), ($1, $4, 'member')`, [orgId, users.recorder, users.reader, users.stranger]);
  }, 300_000);

  afterAll(async () => {
    for (const pool of pools) await pool.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('shares the lines at the publish: before it a reader reads none, after it the reader reads them through the page, the download and the search, a non-reader reads nothing, and the audit row holds a count and no word', async () => {
    const meetingId = await seedMeeting('Họp báo giá', THREE);
    // Before the publish: the recorder reads the working draft; a reader finds no line, no file and no hit.
    const draft = await get('recorder', meetingId);
    expect([draft.stage, draft.isRecorder, draft.segments.map((s) => s.stage)]).toEqual(['draft', true, ['draft', 'draft', 'draft']]);
    expect(await get('reader', meetingId)).toMatchObject({ stage: 'none', isRecorder: false, segments: [] });
    expect(await refuses(download('reader', meetingId))).not.toBeNull();
    expect((await search('reader', 'báo giá')).hits.filter((h) => h.meetingId === meetingId)).toEqual([]);
    // The publish: the transcript alone is something to share (no summary, no item, no chapter), and it says how many lines.
    expect(await publish('recorder', meetingId)).toEqual({ meetingId, results: 0, items: 0, chapters: 0, lines: 3 });
    expect((await stored(meetingId, 'published')).map((r) => r.text)).toEqual(THREE.map((l) => l.said));
    expect(await stored(meetingId, 'draft')).toEqual([]);
    // After it: the reader reads the lines in order, with the stage published.
    const shared = await get('reader', meetingId);
    expect([shared.stage, shared.isRecorder]).toEqual(['published', false]);
    expect(shared.segments.map((s) => [s.startSeconds, s.text, s.stage])).toEqual(THREE.map((l) => [l.at, l.said, 'published']));
    const file = await download('reader', meetingId);
    expect(file.lines).toBe(3);
    for (const l of THREE) expect(text(file)).toContain(l.said);
    expect((await search('reader', 'báo giá')).hits.filter((h) => h.meetingId === meetingId).length).toBeGreaterThan(0);
    // A member who is not a reader of the meeting (the org's owner among them) reads nothing: not the page, not the file, not a hit.
    for (const who of ['owner', 'stranger']) {
      expect(await refuses(get(who, meetingId)), `${who} page`).toBe('MEETING_NOT_FOUND');
      expect(await refuses(download(who, meetingId)), `${who} file`).not.toBeNull();
      expect((await search(who, 'báo giá')).hits.filter((h) => h.meetingId === meetingId), `${who} search`).toEqual([]);
    }
    // Nothing is left to share, and the audit row of the publish carries the counts and never a word of the lines.
    expect(await refuses(publish('recorder', meetingId))).toBe('NOTHING_TO_PUBLISH');
    const audit = await sqlAdmin<{ row: string }>(`SELECT audit_event::text AS row FROM ludy_kernel.audit_event WHERE org_id = $1 AND audit_event::text LIKE '%meetings.result.publish%' AND audit_event::text LIKE $2`, [orgId, `%${meetingId}%`]);
    expect(audit.rows.length).toBeGreaterThan(0);
    const logged = audit.rows.map((r) => r.row).join('\n');
    expect(logged).toContain('"lines"');
    expect(logged).not.toContain(CANARY);
  });

  it('refuses the publish while a line is still the model\'s and unread, clears it by the review of the transcript (the same click as the summary), and then shares it', async () => {
    const meetingId = await seedMeeting('Họp do máy chép');
    // Lines a machine wrote are born tainted (a transcription copies them so).
    for (const l of THREE) {
      await sqlAdmin(
        `INSERT INTO ludy_meetings.transcript_segment (org_id, meeting_id, start_seconds, end_seconds, speaker_label, text, stage, tainted) VALUES ($1, $2, $3, $4, 'Người nói 1', $5, 'draft', true)`,
        [orgId, meetingId, l.at, l.at + 5, l.said],
      );
    }
    // The recorder's results read says how many are unread (a count, never a line), and a reader's is zero.
    expect((await query<{ transcriptUnread: number }>('recorder', 'meetings.result.get', { meetingId })).transcriptUnread).toBe(3);
    expect((await query<{ transcriptUnread: number }>('reader', 'meetings.result.get', { meetingId })).transcriptUnread).toBe(0);
    expect(await refuses(publish('recorder', meetingId))).toBe('DRAFT_NOT_REVIEWED');
    // The refusal changed nothing: the lines are still the recorder's draft, and the reader reads none.
    expect((await stored(meetingId, 'draft')).length).toBe(3);
    expect(await stored(meetingId, 'published')).toEqual([]);
    expect(await get('reader', meetingId)).toMatchObject({ stage: 'none', segments: [] });
    // The review names ids or the transcript: neither is refused; a reader of the meeting is no recorder.
    expect(await refuses(exec('recorder', 'meetings.draft.review', { meetingId, confirmed: true, ids: [] }))).toBe('VALIDATION');
    expect(await refuses(exec('reader', 'meetings.draft.review', { meetingId, confirmed: true, ids: [], transcript: true }))).toBe('FORBIDDEN');
    expect((await stored(meetingId, 'draft')).every((r) => r.tainted)).toBe(true);
    // The recorder's review of the transcript clears every unread line of this meeting, and only those.
    expect(await exec('recorder', 'meetings.draft.review', { meetingId, confirmed: true, ids: [], transcript: true })).toEqual({ meetingId, cleared: 3 });
    expect((await query<{ transcriptUnread: number }>('recorder', 'meetings.result.get', { meetingId })).transcriptUnread).toBe(0);
    expect(await publish('recorder', meetingId)).toMatchObject({ lines: 3 });
    expect((await get('reader', meetingId)).segments.map((s) => s.text)).toEqual(THREE.map((l) => l.said));
  });

  it('replaces the shared lines at the next publish and keeps them for the readers while a new draft waits', async () => {
    const meetingId = await seedMeeting('Họp ghi lại', THREE);
    expect(await publish('recorder', meetingId)).toMatchObject({ lines: 3 });
    // A re-transcription: two new draft lines. The readers still read the three that were shared; the recorder reads the working draft alone (the lines shared before are not listed beside it).
    await store('recorder', meetingId, [{ at: 0, said: 'Bản ghi lại một' }, { at: 12, said: 'Bản ghi lại hai' }]);
    expect((await get('reader', meetingId)).segments.map((s) => s.text)).toEqual(THREE.map((l) => l.said));
    const working = await get('recorder', meetingId);
    expect([working.stage, working.segments.map((s) => s.text)]).toEqual(['draft', ['Bản ghi lại một', 'Bản ghi lại hai']]);
    // The next publish replaces the shared lines whole.
    expect(await publish('recorder', meetingId)).toMatchObject({ lines: 2 });
    expect((await get('reader', meetingId)).segments.map((s) => s.text)).toEqual(['Bản ghi lại một', 'Bản ghi lại hai']);
    expect((await stored(meetingId, 'published')).map((r) => r.text)).toEqual(['Bản ghi lại một', 'Bản ghi lại hai']);
    expect(await stored(meetingId, 'draft')).toEqual([]);
    // A publish with no draft line leaves the shared ones as they are (and, with nothing else to share, is refused).
    expect(await refuses(publish('recorder', meetingId))).toBe('NOTHING_TO_PUBLISH');
    expect((await stored(meetingId, 'published')).length).toBe(2);
  });

  it('shares the summary, the items and the lines in one publish, and counts each', async () => {
    const meetingId = await seedMeeting('Họp đủ phần', THREE);
    await exec('recorder', 'meetings.summary.save', { meetingId, summary: 'Chốt báo giá cho khách A.', decisions: ['Giữ giá cũ'] });
    await exec('recorder', 'meetings.action_item.create', { meetingId, title: 'Gửi báo giá cho khách A', who: 'Hà', whoUserId: null, when: '', whenDate: null, transcriptSeconds: 0 });
    expect(await publish('recorder', meetingId)).toEqual({ meetingId, results: 1, items: 1, chapters: 0, lines: 3 });
    expect((await get('reader', meetingId)).segments).toHaveLength(3);
  });

  it('leaves the table\'s own rules as they were: the tenant role cannot set a stage or delete a shared line, and the definer that does answers the meeting\'s recorder alone', async () => {
    const meetingId = await seedMeeting('Họp quyền', THREE);
    // The recorder, as the tenant role, cannot set the stage of a line (no UPDATE on the column), whatever the policy says.
    await expect(asMember('recorder', (c) => c.query(`UPDATE ludy_meetings.transcript_segment SET stage = 'published' WHERE meeting_id = $1`, [meetingId]))).rejects.toMatchObject({ code: '42501' });
    // The definer answers the recorder's own org and meeting only: a reader of the meeting, a stranger and another org's id are refused, and so is a login with no context.
    for (const who of ['reader', 'stranger', 'owner']) {
      await expect(asMember(who, (c) => c.query(`SELECT ludy_meetings.transcript_publish($1::uuid, $2::uuid)`, [orgId, meetingId])), who).rejects.toThrow(/MEETINGS_PUBLISH_FORBIDDEN/);
    }
    await expect(asMember('recorder', (c) => c.query(`SELECT ludy_meetings.transcript_publish($1::uuid, $2::uuid)`, [randomUUID(), meetingId]))).rejects.toThrow(/MEETINGS_PUBLISH_FORBIDDEN/);
    const bare = new pg.Client({ connectionString: workerUrl });
    await bare.connect();
    try {
      await expect(bare.query(`SELECT ludy_meetings.transcript_publish($1::uuid, $2::uuid)`, [orgId, meetingId])).rejects.toMatchObject({ code: '42501' });
    } finally {
      await bare.end();
    }
    // None of those changed a line.
    expect((await stored(meetingId, 'draft')).length).toBe(3);
    expect(await stored(meetingId, 'published')).toEqual([]);
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
// Highlights on a transcript line or range (#4819) on a real database: the recorder and a reader mark a line or a range of lines at a second where a line they read starts; the meeting's readers
// read every mark, in the order of the transcript, and only a published line can be marked; one member's identical marks are one mark and one member has at most 50 in a meeting; only the author or the recorder removes a mark; a member who
// cannot read the meeting finds no meeting; the marks go with the meeting; the table holds no text, and the audit rows hold seconds, never a line.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import { HIGHLIGHTS_PER_MEMBER_MAX, type HighlightAdded, type HighlightRemoved, type Highlights } from '@ludy/kernel-contract';
import { Runtime } from '@ludy/kernel-runtime';
import { meetingsCommands, meetingsQueries } from '@ludy/mod-meetings';
import { TEST_MANIFESTS } from './invariant/fixtures/manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('Highlights (#4819)', () => {
  const dbName = `ludy_test_highlight_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  const pools: pg.Pool[] = [];
  let orgId = '';
  let runtime: Runtime;
  const users: Record<string, string> = {};
  const NAMES: Record<string, string> = { owner: 'Chủ Công Ty', rec: 'Phạm Quang Minh', lan: 'Trần Thị Lan', nam: 'Nguyễn Văn Nam', other: 'Bạn Không Đọc' };
  const asUser = (who: string) => ({ type: 'user' as const, userId: users[who] as string, aal: 'aal1' as const });
  const mark = (who: string, meetingId: string, startSeconds: number, endSeconds = startSeconds) =>
    runtime.execute<HighlightAdded>('meetings.highlight.add', { meetingId, startSeconds, endSeconds }, { actor: asUser(who), orgId });
  const unmark = (who: string, meetingId: string, highlightId: string) => runtime.execute<HighlightRemoved>('meetings.highlight.remove', { meetingId, highlightId }, { actor: asUser(who), orgId });
  const list = (who: string, meetingId: string) => runtime.query<Highlights>('meetings.highlight.list', { meetingId }, { actor: asUser(who), orgId });
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
    for (const key of Object.keys(NAMES)) users[key] = await upsertIdentity(db, { issuer: 'hl', subject: key, email: `${key}@hl.test`, name: NAMES[key] as string });
    orgId = (await createOrg(runtime, asUser('owner'), 'Công ty Đoạn Nổi Bật')).orgId;
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

  // Five lines at 10, 20, 30, 40 and 50 seconds; the first four published, the last still a draft.
  async function fiveLines(title: string): Promise<string> {
    const id = await meeting(title);
    for (const s of [10, 20, 30, 40]) await say(id, s, `Dòng published ${s}`, 'published');
    await say(id, 50, 'Dòng nháp 50', 'draft');
    return id;
  }

  it('marks a line and a range; the readers read every mark in the order of the transcript, with who made it', async () => {
    const id = await fiveLines('Họp giao ban');
    const range = await mark('rec', id, 20, 40);
    const single = await mark('rec', id, 10);
    expect(range.created).toBe(true);
    expect(single.created).toBe(true);
    const fromLan = await mark('lan', id, 30);

    const seen = await list('nam', id);
    expect(seen.highlights.map((h) => [h.startSeconds, h.endSeconds, h.mine, h.markedBy])).toEqual([
      [10, 10, false, NAMES.rec],
      [20, 40, false, NAMES.rec],
      [30, 30, false, NAMES.lan],
    ]);
    const own = await list('lan', id);
    expect(own.highlights.find((h) => h.id === fromLan.highlightId)).toMatchObject({ mine: true, markedBy: null });
    expect(own.highlights.find((h) => h.id === range.highlightId)).toMatchObject({ mine: false, markedBy: NAMES.rec });
  });

  it('refuses a second that no published line starts at, for a reader and for the recorder', async () => {
    const id = await fiveLines('Họp kiểm tra điểm neo');
    await expect(mark('lan', id, 25)).rejects.toMatchObject({ code: 'HIGHLIGHT_NOT_ANCHORED' });
    await expect(mark('lan', id, 10, 99)).rejects.toMatchObject({ code: 'HIGHLIGHT_NOT_ANCHORED' });
    // The last line is a draft: a reader does not read it, and not even the recorder marks it (a mark on it would tell the readers where the draft is).
    await expect(mark('lan', id, 50)).rejects.toMatchObject({ code: 'HIGHLIGHT_NOT_ANCHORED' });
    await expect(mark('rec', id, 50)).rejects.toMatchObject({ code: 'HIGHLIGHT_NOT_ANCHORED' });
    expect((await mark('rec', id, 40)).created).toBe(true);
    // An end before the start is refused by the shape.
    await expect(runtime.execute('meetings.highlight.add', { meetingId: id, startSeconds: 40, endSeconds: 10 }, { actor: asUser('rec'), orgId })).rejects.toThrow();
  });

  it('one member marking the same range twice makes one mark; one member has at most 50 in a meeting', async () => {
    const id = await meeting('Họp nhiều đoạn nổi bật');
    for (let s = 0; s <= HIGHLIGHTS_PER_MEMBER_MAX; s++) await say(id, s, `Dòng ${s}`, 'published');
    const first = await mark('lan', id, 7);
    const again = await mark('lan', id, 7);
    expect(again).toEqual({ meetingId: id, highlightId: first.highlightId, created: false });
    // Another member's identical range is their own mark.
    expect((await mark('nam', id, 7)).highlightId).not.toBe(first.highlightId);
    for (let s = 0; s < HIGHLIGHTS_PER_MEMBER_MAX; s++) if (s !== 7) await mark('lan', id, s);
    expect((await list('lan', id)).highlights.filter((h) => h.mine)).toHaveLength(HIGHLIGHTS_PER_MEMBER_MAX);
    await expect(mark('lan', id, HIGHLIGHTS_PER_MEMBER_MAX)).rejects.toMatchObject({ code: 'HIGHLIGHT_LIMIT' });
    // The mark that already exists is still answered at the limit (nothing new is made), and another member is not held by this member's count.
    expect((await mark('lan', id, 7)).created).toBe(false);
    expect((await mark('nam', id, HIGHLIGHTS_PER_MEMBER_MAX)).created).toBe(true);
  }, 120_000);

  it('only the author or the recorder removes a mark; an unknown mark is not found', async () => {
    const id = await fiveLines('Họp bỏ đoạn nổi bật');
    const byLan = await mark('lan', id, 10);
    const byNam = await mark('nam', id, 20);
    // A reader does not remove another reader's mark.
    await expect(unmark('nam', id, byLan.highlightId)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect((await list('nam', id)).highlights).toHaveLength(2);
    // The author does, and the recorder removes any mark of their meeting.
    expect(await unmark('lan', id, byLan.highlightId)).toEqual({ meetingId: id, highlightId: byLan.highlightId });
    expect(await unmark('rec', id, byNam.highlightId)).toEqual({ meetingId: id, highlightId: byNam.highlightId });
    expect((await list('rec', id)).highlights).toEqual([]);
    await expect(unmark('rec', id, byNam.highlightId)).rejects.toMatchObject({ code: 'HIGHLIGHT_NOT_FOUND' });
    // The recorder's own mark is not removed by a reader either.
    const byRec = await mark('rec', id, 30);
    await expect(unmark('lan', id, byRec.highlightId)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('a member who cannot read the meeting finds no meeting, and an owner has no extra right to it', async () => {
    const id = await fiveLines('Họp riêng của nhóm');
    const own = await mark('rec', id, 10);
    for (const who of ['other', 'owner']) {
      await expect(list(who, id), `list ${who}`).rejects.toMatchObject({ code: 'MEETING_NOT_FOUND' });
      await expect(mark(who, id, 10), `add ${who}`).rejects.toMatchObject({ code: 'MEETING_NOT_FOUND' });
      await expect(unmark(who, id, own.highlightId), `remove ${who}`).rejects.toMatchObject({ code: 'MEETING_NOT_FOUND' });
    }
    expect((await list('lan', id)).highlights).toHaveLength(1);
  });

  it('the marks go with the meeting, and the table holds no text', async () => {
    const id = await fiveLines('Họp bị xóa');
    await mark('rec', id, 10, 30);
    await mark('lan', id, 20);
    expect((await sqlAdmin('SELECT count(*)::int AS n FROM ludy_meetings.meeting_highlight WHERE org_id = $1 AND meeting_id = $2', [orgId, id])).rows[0]).toEqual({ n: 2 });
    await sqlAdmin('DELETE FROM ludy_meetings.meeting WHERE org_id = $1 AND id = $2', [orgId, id]);
    expect((await sqlAdmin('SELECT count(*)::int AS n FROM ludy_meetings.meeting_highlight WHERE org_id = $1 AND meeting_id = $2', [orgId, id])).rows[0]).toEqual({ n: 0 });
    // Nothing a person wrote is kept here: no column of the table is text, so the personal-data finder and the erasure have nothing to reach.
    const columns = await sqlAdmin<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'ludy_meetings' AND table_name = 'meeting_highlight' ORDER BY ordinal_position`,
    );
    expect(columns.rows.filter((c) => ['text', 'character varying', 'json', 'jsonb'].includes(c.data_type))).toEqual([]);
  });

  it('the audit rows hold the meeting and two seconds, never a line', async () => {
    const id = await meeting('Họp kiểm toán đoạn nổi bật');
    await say(id, 15, 'Nội dung rất riêng của dòng nổi bật', 'published');
    const made = await mark('lan', id, 15);
    await unmark('lan', id, made.highlightId);
    const audit = await sqlAdmin<{ row: string }>(
      `SELECT audit_event::text AS row FROM ludy_kernel.audit_event WHERE org_id = $1 AND audit_event::text LIKE '%meetings.highlight.%' AND audit_event::text LIKE $2`,
      [orgId, `%${id}%`],
    );
    expect(audit.rows.length).toBeGreaterThanOrEqual(2);
    const text = audit.rows.map((r) => r.row).join('\n');
    for (const secret of ['rất riêng', 'Họp kiểm toán']) expect(text, secret).not.toContain(secret);
    expect(text).toContain('startSeconds');
  });

  // The order of a mark and a re-publish (#4971). A reader cannot hold the meeting row, so the add and the publish take one advisory lock of the meeting (key `meetings.lines:<org>:<meeting>`): the publish exclusively, the add shared.
  const LINES_LOCK = "pg_catalog.hashtextextended('meetings.lines:' || lower($1::text) || ':' || lower($2::text), 0)";
  // A transaction of its own that holds the lock, to play the other side.
  async function holding<T>(meetingId: string, mode: 'pg_advisory_xact_lock' | 'pg_advisory_xact_lock_shared', during: (c: pg.Client) => Promise<T>, release: (c: pg.Client) => Promise<void>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT pg_catalog.${mode}(${LINES_LOCK})`, [orgId, meetingId]);
      const out = await during(c);
      await release(c);
      return out;
    } finally {
      await c.end();
    }
  }
  const settledWithin = async (promise: Promise<unknown>, ms: number): Promise<boolean> => {
    let settled = false;
    void promise.then(
      () => (settled = true),
      () => (settled = true),
    );
    await new Promise((resolve) => setTimeout(resolve, ms));
    return settled;
  };

  it('an add that meets a publish in progress waits for it and is checked against the lines it leaves', async () => {
    const id = await fiveLines('Họp đánh dấu trong lúc công bố lại');
    let add!: Promise<unknown>;
    let waited = true;
    await holding(
      id,
      'pg_advisory_xact_lock',
      async (c) => {
        // The publish is half done: the old published lines are gone, new ones stand at other seconds.
        await c.query("DELETE FROM ludy_meetings.transcript_segment WHERE org_id = $1 AND meeting_id = $2 AND stage = 'published'", [orgId, id]);
        await c.query(`INSERT INTO ludy_meetings.transcript_segment (org_id, meeting_id, start_seconds, end_seconds, speaker_label, text, stage) VALUES ($1, $2, 70, 75, 'Người nói 1', 'Dòng mới 70', 'published')`, [orgId, id]);
        add = mark('lan', id, 20).then(
          () => 'added',
          (error: unknown) => error,
        );
        waited = !(await settledWithin(add, 600));
      },
      async (c) => {
        await c.query('COMMIT');
      },
    );
    expect(waited, 'the add waits while the publish holds the lines').toBe(true);
    // Once the publish has committed the add reads the new lines: second 20 starts none of them.
    expect(await add).toMatchObject({ code: 'HIGHLIGHT_NOT_ANCHORED' });
    expect((await sqlAdmin('SELECT count(*)::int AS n FROM ludy_meetings.meeting_highlight WHERE org_id = $1 AND meeting_id = $2', [orgId, id])).rows[0]).toEqual({ n: 0 });
    expect((await mark('lan', id, 70)).created).toBe(true);
  });

  it('a publish that meets an add in progress waits for it', async () => {
    const id = await meeting('Họp công bố lúc có người đánh dấu');
    await say(id, 10, 'Dòng nháp', 'draft');
    let publish!: Promise<unknown>;
    let waited = true;
    await holding(
      id,
      'pg_advisory_xact_lock_shared',
      async () => {
        publish = runtime.execute<{ lines: number }>('meetings.result.publish', { meetingId: id, confirmed: true }, { actor: asUser('rec'), orgId }).then(
          (out) => out,
          (error: unknown) => error,
        );
        waited = !(await settledWithin(publish, 600));
      },
      async (c) => {
        await c.query('COMMIT');
      },
    );
    expect(waited, 'the publish waits while an add holds the lines').toBe(true);
    expect(await publish).toMatchObject({ lines: 1 });
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
// The recorder copying their Vy's summary of a meeting into their draft (#2580, M6 part B1) on a real database: only the recorder, only a finished run of
// this meeting's summary, the body read back strictly; the draft rows are the model's (tainted), the "who" is matched to an attendee only when one answers to
// the name, the "when" is parsed by code against the meeting's date, and a link in a title is flagged. A new run replaces the model's drafts and leaves
// what the recorder typed. Nothing is shared and an attendee reads none of it until the recorder publishes. The run itself (the route that asks the model)
// is part B2; here the result is stored as that route will store it.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { meetingsCommands, meetingsQueries, setSummaryEnabled } from '@crove/mod-meetings';
import { TEST_MANIFESTS } from './invariant/fixtures/manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('the recorder\'s Vy summary copied into the draft (#2580, M6 part B1)', () => {
  const dbName = `crove_test_summary_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
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

  // A meeting held on 2026-11-10 (a Tuesday), recorded by `recorder` and shared with `readers`.
  async function seedMeeting(recorder: string, readers: string[]): Promise<string> {
    const meetingId = randomUUID();
    await sqlAdmin(
      `INSERT INTO crove_meetings.meeting (org_id, id, title, language, started_at, ended_at, length_seconds, recorder_user_id, visibility, status, consent_method, consent_confirmed_by, consent_confirmed_at, consent_notice_version, audio_retention_date, text_retention_date)
       VALUES ($1, $2, 'Họp tuần', 'vi', '2026-11-10T03:00:00Z', '2026-11-10T03:30:00Z', 1800, $3, 'attendees', 'ready', 'told_at_start', $3, now(), '1.0', current_date + 30, current_date + 365)`,
      [orgId, meetingId, users[recorder]],
    );
    for (const reader of readers) await sqlAdmin(`INSERT INTO crove_meetings.meeting_reader (org_id, id, meeting_id, user_id) VALUES ($1, $2, $3, $4)`, [orgId, randomUUID(), meetingId, users[reader]]);
    return meetingId;
  }
  // A finished run of `who`'s Vy for the meeting, its result stored as the interactive route will store it.
  async function finishedRun(who: string, meetingId: string, body: unknown, feature = 'meetings.summary'): Promise<string> {
    const started = await exec<{ runId: string }>(who, 'kernel.member_vy.run.start', { feature, subjectType: 'meeting', subjectId: meetingId });
    await exec(who, 'kernel.member_vy.result.store', { runId: started.runId, outcome: { status: 'ready', body: typeof body === 'string' ? body : JSON.stringify(body) } });
    return started.runId;
  }
  type Results = { draft: { summary: string; decisions: string[]; feature: string; tainted: boolean } | null; published: unknown; items: Array<{ title: string; who: string; whoUserId: string | null; when: string; whenDate: string | null; transcriptSeconds: number | null; flags: string[]; tainted: boolean; stage: string }> };
  const results = (who: string, meetingId: string) => query<Results>(who, 'meetings.result.get', { meetingId });
  const BODY = {
    summary: 'Cuộc họp bàn báo giá cho khách A.',
    decisions: ['Giữ giá cũ'],
    items: [
      { title: 'Gửi báo giá cho khách A', who: 'Lan', when: 'thứ sáu', seconds: 25 },
      { title: 'Xem https://evil.example/x', who: 'Nam', when: 'ngày mai', seconds: 40 },
      { title: 'Đặt lịch họp', who: 'Minh', when: 'tuần sau', seconds: null },
    ],
    dropped: 2,
  };

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
    const url = new URL(adminUrl);
    url.username = 'crove_app';
    url.password = 'test-app-pw';
    const pool = createPool({ connectionString: url.toString(), max: 4 });
    pools.push(pool);
    runtime = new Runtime(createDb(pool), { manifests: TEST_MANIFESTS }).register({
      commands: [...kernelCommands, ...meetingsCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...meetingsQueries],
    });
    setSummaryEnabled(true);
    const names: Record<string, string> = { owner: 'Chủ', recorder: 'Hà', attendee: 'Nguyễn Thị Lan', another: 'Trần Văn Nam', twin: 'Phạm Văn Nam', stranger: 'Người ngoài' };
    for (const key of Object.keys(names)) users[key] = await upsertIdentity(createDb(pool), { issuer: 'summary', subject: key, email: `${key}@summary.test`, name: names[key] as string });
    orgId = (await createOrg(runtime, asUser('owner'), 'Tóm tắt')).orgId;
    await sqlAdmin(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member'), ($1, $4, 'member'), ($1, $5, 'member'), ($1, $6, 'member')`, [orgId, users.recorder, users.attendee, users.another, users.twin, users.stranger]);
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

  it('copies a finished run into a tainted draft: names matched to one attendee, dates read by code, a link flagged', async () => {
    const meetingId = await seedMeeting('recorder', ['attendee', 'another']);
    const runId = await finishedRun('recorder', meetingId, BODY);
    const out = await exec('recorder', 'meetings.summary.copy_result', { meetingId, runId });
    expect(out).toEqual({ meetingId, decisions: 1, items: 3, dropped: 2 });
    const view = await results('recorder', meetingId);
    expect(view.draft).toMatchObject({ summary: 'Cuộc họp bàn báo giá cho khách A.', decisions: ['Giữ giá cũ'], feature: 'meetings.summary', tainted: true });
    const byTitle = Object.fromEntries(view.items.map((i) => [i.title, i]));
    // "Lan" is one word of one attendee's name; "thứ sáu" after Tuesday 2026-11-10 is Friday 2026-11-13.
    expect(byTitle['Gửi báo giá cho khách A']).toMatchObject({ whoUserId: users.attendee, whenDate: '2026-11-13', transcriptSeconds: 25, flags: [], tainted: true, stage: 'draft' });
    // "Nam" names the attendee "Trần Văn Nam" (the other Nam is not in this meeting); "ngày mai" is the 11th; the link is flagged for a person to read.
    expect(byTitle['Xem https://evil.example/x']).toMatchObject({ whoUserId: users.another, whenDate: '2026-11-11', flags: ['contact_in_title'], tainted: true });
    // "Minh" is nobody here and "tuần sau" is no day: a person picks.
    expect(byTitle['Đặt lịch họp']).toMatchObject({ whoUserId: null, whenDate: null, transcriptSeconds: null });
    // Nothing is shared: an attendee reads nothing of it until the recorder publishes.
    expect(await results('attendee', meetingId)).toMatchObject({ draft: null, published: null, items: [] });
    // Nobody is clean here yet (no seats): the screen asks a person for each.
    expect(view.items.every((i) => (i as { clean?: boolean }).clean === false)).toBe(true);
  });

  it('leaves a name that two attendees answer to for a person to pick', async () => {
    const meetingId = await seedMeeting('recorder', ['another', 'twin']);
    const runId = await finishedRun('recorder', meetingId, { summary: 'Họp.', decisions: [], items: [{ title: 'Gửi báo giá', who: 'Nam', when: '', seconds: null }], dropped: 0 });
    await exec('recorder', 'meetings.summary.copy_result', { meetingId, runId });
    expect((await results('recorder', meetingId)).items[0]).toMatchObject({ whoUserId: null });
  });

  it('is the recorder\'s alone and only for a finished summary run of this very meeting', async () => {
    const meetingId = await seedMeeting('recorder', ['attendee']);
    const other = await seedMeeting('recorder', []);
    const runId = await finishedRun('recorder', meetingId, BODY);
    expect(await refuses(exec('attendee', 'meetings.summary.copy_result', { meetingId, runId }))).toBe('FORBIDDEN');
    expect(await refuses(exec('stranger', 'meetings.summary.copy_result', { meetingId, runId }))).toBe('MEETING_NOT_FOUND');
    // A run of another meeting, a run of another feature, a run that is not finished, an id that is no run, and a body that is not a summary.
    expect(await refuses(exec('recorder', 'meetings.summary.copy_result', { meetingId: other, runId }))).toBe('SUMMARY_RESULT_NOT_FOUND');
    const transcribe = await finishedRun('recorder', meetingId, BODY, 'meetings.transcribe');
    expect(await refuses(exec('recorder', 'meetings.summary.copy_result', { meetingId, runId: transcribe }))).toBe('SUMMARY_RESULT_NOT_FOUND');
    const running = await exec<{ runId: string }>('recorder', 'kernel.member_vy.run.start', { feature: 'meetings.summary', subjectType: 'meeting', subjectId: other });
    expect(await refuses(exec('recorder', 'meetings.summary.copy_result', { meetingId: other, runId: running.runId }))).toBe('SUMMARY_RESULT_NOT_READY');
    expect(await refuses(exec('recorder', 'meetings.summary.copy_result', { meetingId, runId: randomUUID() }))).toBe('SUMMARY_RESULT_NOT_FOUND');
    const third = await seedMeeting('recorder', []);
    expect(await refuses(exec('recorder', 'meetings.summary.copy_result', { meetingId: third, runId: await finishedRun('recorder', third, 'not json') }))).toBe('SUMMARY_RESULT_INVALID');
    const fourth = await seedMeeting('recorder', []);
    expect(await refuses(exec('recorder', 'meetings.summary.copy_result', { meetingId: fourth, runId: await finishedRun('recorder', fourth, { summary: 'x', decisions: [], items: [{ title: 'y', who: '', when: '', seconds: -1 }], dropped: 0 }) }))).toBe('SUMMARY_RESULT_INVALID');
  });

  it('is off until the deployment turns it on', async () => {
    const meetingId = await seedMeeting('recorder', []);
    const runId = await finishedRun('recorder', meetingId, BODY);
    setSummaryEnabled(false);
    try {
      expect(await refuses(exec('recorder', 'meetings.summary.copy_result', { meetingId, runId }))).toBe('SUMMARY_OFF');
    } finally {
      setSummaryEnabled(true);
    }
  });

  it('replaces the model\'s drafts on a new run and leaves what the recorder typed, and an edit of a title makes the item theirs', async () => {
    const meetingId = await seedMeeting('recorder', ['attendee']);
    await exec('recorder', 'meetings.action_item.create', { meetingId, title: 'Tự viết', who: '', whoUserId: null, when: '', whenDate: null, transcriptSeconds: null });
    await exec('recorder', 'meetings.summary.copy_result', { meetingId, runId: await finishedRun('recorder', meetingId, BODY) });
    expect((await results('recorder', meetingId)).items).toHaveLength(4);
    await exec('recorder', 'meetings.summary.copy_result', { meetingId, runId: await finishedRun('recorder', meetingId, { summary: 'Họp lần hai.', decisions: [], items: [{ title: 'Việc mới', who: '', when: '', seconds: null }], dropped: 0 }) });
    const view = await results('recorder', meetingId);
    expect(view.draft).toMatchObject({ summary: 'Họp lần hai.', tainted: true });
    expect(view.items.map((i) => i.title).sort()).toEqual(['Tự viết', 'Việc mới']);
    expect(view.items.find((i) => i.title === 'Tự viết')?.tainted).toBe(false);
    expect(view.items.find((i) => i.title === 'Việc mới')?.tainted).toBe(true);
    const id = (await sqlAdmin<{ id: string }>(`SELECT id FROM crove_meetings.action_item WHERE org_id = $1 AND meeting_id = $2 AND title = 'Việc mới'`, [orgId, meetingId])).rows[0]?.id as string;
    await exec('recorder', 'meetings.action_item.edit', { itemId: id, whenDate: '2026-11-20' });
    expect((await results('recorder', meetingId)).items.find((i) => i.title === 'Việc mới')?.tainted).toBe(true);
    await exec('recorder', 'meetings.action_item.edit', { itemId: id, title: 'Việc mới, đã sửa' });
    expect((await results('recorder', meetingId)).items.find((i) => i.title === 'Việc mới, đã sửa')?.tainted).toBe(false);
  });
});

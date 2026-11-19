// SPDX-License-Identifier: AGPL-3.0-only
// The recorder's Vy writing the chapters of a meeting through the API's route logic (#3844, step 3, ADR-0049 stage A) on a real database, with a fake model: who may start it (the recorder
// only, with vy.use, in their own org, with the deployment's switch on), that the run is bound to this meeting under its own feature key, that the model is asked once with the transcript between
// the run's tags, that every failure is a fixed code, that a too long transcript is refused before any call, and that neither the transcript nor the answer reaches a log.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AiBudgetExhaustedError, type AiMeter } from '@crove/agent';
import type { ModelPort } from '@crove/agent/member-vy';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { meetingsCommands, meetingsQueries, setSummaryEnabled } from '@crove/mod-meetings';
import { DraftBudget } from '../src/ai-draft-limit.ts';
import { runMeetingChapters, type MeetingSummaryDeps } from '../src/member-vy-ports.ts';
import { TEST_MANIFESTS } from './invariant/fixtures/manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

const SECRET_LINE = 'Khách A hẹn gặp tại quán cà phê Bình Minh lúc 9 giờ';
const SECRET_TITLE = 'Gặp khách A ở quán';

suite('the recorder\'s Vy chapters route (#3844, step 3)', () => {
  const dbName = `crove_test_chapters_route_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  const pools: pg.Pool[] = [];
  let orgId = '';
  let otherOrgId = '';
  let runtime: Runtime;
  const users: Record<string, string> = {};
  const asUser = (who: string) => ({ type: 'user' as const, userId: users[who] as string, aal: 'aal1' as const });
  const exec = <O = unknown>(who: string, name: string, input: unknown, org = orgId) => runtime.execute<O>(name, input, { actor: asUser(who), orgId: org });
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

  // What the model was given and what it said, and everything a handler wrote to the console.
  let modelCalls = 0;
  const logged: string[] = [];
  const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) => vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(' '))));
  afterEach(() => {
    logged.length = 0;
    modelCalls = 0;
    setSummaryEnabled(true);
  });

  const answer = JSON.stringify({ chapters: [{ title: SECRET_TITLE, startSecond: 0 }, { title: 'Gửi báo giá', startSecond: 10 }] });
  let lastPrompt: { system: string; user: string; feature?: string | undefined } | null = null;
  const model = (text: string | (() => Promise<string>)): ModelPort => ({
    generate: async (_who, prompt) => {
      modelCalls += 1;
      lastPrompt = prompt;
      const out = typeof text === 'string' ? text : await text();
      return { text: out, usage: { inputTokens: 100, outputTokens: 30 } };
    },
  });
  const meter: AiMeter = { admit: async () => undefined, record: async () => undefined };
  const deps = (over: Partial<MeetingSummaryDeps> = {}): MeetingSummaryDeps => ({ runtime, model: model(answer), meter: () => meter, budget: new DraftBudget({ perUserPerMinute: 100, perOrgPerMinute: 100 }), timeoutMs: 2000, ...over });

  async function seedMeeting(recorder: string, segments: Array<[number, number, string]> = [[0, 10, SECRET_LINE], [10, 20, 'Hà sẽ gửi báo giá trước thứ sáu']], org = orgId): Promise<string> {
    const meetingId = randomUUID();
    await sqlAdmin(
      `INSERT INTO crove_meetings.meeting (org_id, id, title, language, started_at, ended_at, length_seconds, recorder_user_id, visibility, status, consent_method, consent_confirmed_by, consent_confirmed_at, consent_notice_version, audio_retention_date, text_retention_date)
       VALUES ($1, $2, 'Họp tuần', 'vi', '2026-11-10T03:00:00Z', '2026-11-10T03:30:00Z', 1800, $3, 'attendees', 'ready', 'told_at_start', $3, now(), '1.0', current_date + 30, current_date + 365)`,
      [org, meetingId, users[recorder]],
    );
    if (segments.length > 0 && recorder === 'viewer') {
      // A viewer cannot store a transcript through the command: a segment is put there directly (the case is a recorder who then lost vy.use).
      await sqlAdmin(`INSERT INTO crove_meetings.transcript_segment (org_id, id, meeting_id, start_seconds, end_seconds, speaker_label, text, stage) VALUES ($1, $2, $3, 0, 10, 'Hà', 'Một dòng', 'draft')`, [org, randomUUID(), meetingId]);
    } else if (segments.length > 0) {
      await exec(recorder, 'meetings.transcript.draft_store', { meetingId, segments: segments.map(([startSeconds, endSeconds, text]) => ({ startSeconds, endSeconds, speakerLabel: 'Hà', text })) }, org);
    }
    return meetingId;
  }
  const runs = async (meetingId: string) => (await sqlAdmin<{ status: string; error_code: string | null; subject_type: string; subject_id: string; feature: string }>(`SELECT status, error_code, subject_type, subject_id, feature FROM crove_kernel.member_vy_result WHERE org_id = $1 AND subject_id = $2`, [orgId, meetingId])).rows;

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
    for (const key of ['owner', 'recorder', 'attendee', 'viewer', 'foreign', 'nouse']) users[key] = await upsertIdentity(createDb(pool), { issuer: 'chapters-route', subject: key, email: `${key}@chapters-route.test`, name: key === 'recorder' ? 'Hà' : null });
    orgId = (await createOrg(runtime, asUser('owner'), 'Mục lục chạy')).orgId;
    otherOrgId = (await createOrg(runtime, asUser('foreign'), 'Org khác')).orgId;
    await sqlAdmin(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member'), ($1, $4, 'viewer'), ($1, $5, 'member')`, [orgId, users.recorder, users.attendee, users.viewer, users.nouse]);
  }, 300_000);

  afterAll(async () => {
    spies.forEach((s) => s.mockRestore());
    setSummaryEnabled(false);
    for (const pool of pools) await pool.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('runs end to end: the run is bound to the meeting, the model is asked once, the result is stored for the recorder, and the recorder copies it into a tainted draft', async () => {
    const meetingId = await seedMeeting('recorder');
    const out = await runMeetingChapters(deps(), orgId, asUser('recorder'), meetingId);
    expect(out).toMatchObject({ meetingId, state: 'ready', errorCode: null });
    expect(modelCalls).toBe(1);
    expect(lastPrompt).toMatchObject({ feature: 'meetings.chapters' });
    expect((lastPrompt as unknown as { user: string }).user).toContain('[0:00] Hà: Khách A hẹn gặp');
    expect(await runs(meetingId)).toEqual([{ status: 'ready', error_code: null, subject_type: 'meeting', subject_id: meetingId, feature: 'meetings.chapters' }]);
    expect(await exec('recorder', 'meetings.chapters.copy_result', { meetingId, runId: out.runId })).toEqual({ meetingId, chapters: 2, dropped: 0 });
    const rows = await sqlAdmin<{ title: string; start_seconds: number; tainted: boolean; stage: string }>(`SELECT title, start_seconds, tainted, stage FROM crove_meetings.meeting_chapter WHERE meeting_id = $1 ORDER BY position`, [meetingId]);
    expect(rows.rows).toEqual([{ title: SECRET_TITLE, start_seconds: 0, tainted: true, stage: 'draft' }, { title: 'Gửi báo giá', start_seconds: 10, tainted: true, stage: 'draft' }]);
    // Nothing the member said or the model answered reached a log.
    const everything = logged.join('\n');
    expect(everything).not.toContain('Bình Minh');
    expect(everything).not.toContain(SECRET_TITLE);
  });

  it('refuses a member without vy.use, a member who is not the recorder, another org and a switch that is off, before any model call and without a run', async () => {
    const noUse = await seedMeeting('nouse');
    await exec('owner', 'kernel.member.permission.set', { userId: users.nouse, permission: 'vy.use', allowed: false });
    expect(await refuses(runMeetingChapters(deps(), orgId, asUser('nouse'), noUse))).toBe('VY_NOT_ALLOWED');
    expect(await refuses(runMeetingChapters(deps(), orgId, asUser('viewer'), noUse))).toBe('FORBIDDEN');
    const mine = await seedMeeting('recorder');
    expect(await refuses(runMeetingChapters(deps(), orgId, asUser('attendee'), mine))).toBe('MEETING_NOT_FOUND');
    await sqlAdmin(`INSERT INTO crove_meetings.meeting_reader (org_id, id, meeting_id, user_id) VALUES ($1, $2, $3, $4)`, [orgId, randomUUID(), mine, users.attendee]);
    expect(await refuses(runMeetingChapters(deps(), orgId, asUser('attendee'), mine))).toBe('FORBIDDEN');
    expect(await refuses(runMeetingChapters(deps(), otherOrgId, asUser('foreign'), mine))).toBe('MEETING_NOT_FOUND');
    setSummaryEnabled(false);
    expect(await refuses(runMeetingChapters(deps(), orgId, asUser('recorder'), mine))).toBe('SUMMARY_OFF');
    setSummaryEnabled(true);
    expect(await refuses(runMeetingChapters(deps({ model: null }), orgId, asUser('recorder'), mine))).toBe('SUMMARY_OFF');
    expect(modelCalls).toBe(0);
    for (const id of [noUse, mine]) expect(await runs(id)).toEqual([]);
  });

  it('refuses a meeting with no transcript, and a run of another meeting cannot be copied into this one', async () => {
    const empty = await seedMeeting('recorder', []);
    expect(await refuses(runMeetingChapters(deps(), orgId, asUser('recorder'), empty))).toBe('TRANSCRIPT_EMPTY');
    const a = await seedMeeting('recorder');
    const b = await seedMeeting('recorder');
    const done = await runMeetingChapters(deps(), orgId, asUser('recorder'), a);
    expect(await refuses(exec('recorder', 'meetings.chapters.copy_result', { meetingId: b, runId: done.runId }))).toBe('SUMMARY_RESULT_NOT_FOUND');
  });

  it('leaves the run failed with a fixed code when the model never answers, and stores nothing to copy', async () => {
    const meetingId = await seedMeeting('recorder');
    const out = await runMeetingChapters(deps({ model: model(() => new Promise<string>(() => undefined)), timeoutMs: 150 }), orgId, asUser('recorder'), meetingId);
    expect(out).toMatchObject({ state: 'failed', errorCode: 'CHAPTERS_TIMEOUT' });
    expect(await runs(meetingId)).toEqual([{ status: 'failed', error_code: 'CHAPTERS_TIMEOUT', subject_type: 'meeting', subject_id: meetingId, feature: 'meetings.chapters' }]);
    expect(await refuses(exec('recorder', 'meetings.chapters.copy_result', { meetingId, runId: out.runId }))).toBe('SUMMARY_RESULT_NOT_READY');
  });

  it('names every other failure by a fixed code: a spent budget, an unusable answer, one with no chapter at a real line, a model that fails, a transcript over the cap', async () => {
    const meetingId = await seedMeeting('recorder');
    const code = async (port: ModelPort, id = meetingId) => (await runMeetingChapters(deps({ model: port }), orgId, asUser('recorder'), id)).errorCode;
    expect(await code({ generate: async () => { throw new AiBudgetExhaustedError('org', null); } })).toBe('AI_BUDGET_EXHAUSTED');
    expect(await code(model('xin lỗi, tôi không làm được'))).toBe('CHAPTERS_UNPARSABLE');
    expect(await code(model('{"chapters":[{"title":"Ở đâu đó","startSecond":99999},{"title":"Xem https://evil.example","startSecond":0}]}'))).toBe('CHAPTERS_EMPTY');
    expect(await code({ generate: async () => { throw new Error(`provider said: ${SECRET_LINE}`); } })).toBe('CHAPTERS_FAILED');
    const long = await seedMeeting('recorder', Array.from({ length: 20 }, (_, i): [number, number, string] => [i * 10, i * 10 + 9, 'x'.repeat(3900)]));
    const before = modelCalls;
    expect(await code(model(answer), long)).toBe('CHAPTERS_TOO_LONG');
    expect(modelCalls).toBe(before);
    expect(logged.join('\n')).not.toContain('Bình Minh');
    expect(logged.join('\n')).toContain('CHAPTERS_FAILED');
  });

  it('is rate limited per member and spends no rate on a member who is refused', async () => {
    const meetingId = await seedMeeting('recorder');
    await sqlAdmin(`INSERT INTO crove_meetings.meeting_reader (org_id, id, meeting_id, user_id) VALUES ($1, $2, $3, $4)`, [orgId, randomUUID(), meetingId, users.attendee]);
    const orgBudget = new DraftBudget({ perUserPerMinute: 100, perOrgPerMinute: 1 });
    for (let i = 0; i < 3; i += 1) expect(await refuses(runMeetingChapters(deps({ budget: orgBudget }), orgId, asUser('attendee'), meetingId))).toBe('FORBIDDEN');
    expect((await runMeetingChapters(deps({ budget: orgBudget }), orgId, asUser('recorder'), meetingId)).state).toBe('ready');
    const budget = new DraftBudget({ perUserPerMinute: 1, perOrgPerMinute: 100 });
    const other = await seedMeeting('recorder');
    expect((await runMeetingChapters(deps({ budget }), orgId, asUser('recorder'), other)).state).toBe('ready');
    expect(await refuses(runMeetingChapters(deps({ budget }), orgId, asUser('recorder'), other))).toBe('SUMMARY_BUSY');
  });

  it('does not cancel a transcription of the recorder that is still running, and writes the chapters of another meeting meanwhile (one live Vy run per feature, #3029)', async () => {
    const meetingId = await seedMeeting('recorder');
    const other = await seedMeeting('recorder');
    const live = await exec<{ runId: string }>('recorder', 'kernel.member_vy.run.start', { feature: 'meetings.transcribe', subjectType: 'meeting', subjectId: other });
    const before = modelCalls;
    expect((await runMeetingChapters(deps(), orgId, asUser('recorder'), meetingId)).state).toBe('ready');
    expect(modelCalls).toBe(before + 1);
    const state = await sqlAdmin<{ status: string; error: string | null }>('SELECT status, error FROM crove_kernel.ai_run WHERE org_id = $1 AND id = $2', [orgId, live.runId]);
    expect(state.rows[0]).toEqual({ status: 'running', error: null });
  });

  it('refuses chapters of a meeting whose own transcription is still running, and starts once it has finished', async () => {
    const meetingId = await seedMeeting('recorder');
    const live = await exec<{ runId: string }>('recorder', 'kernel.member_vy.run.start', { feature: 'meetings.transcribe', subjectType: 'meeting', subjectId: meetingId });
    const before = modelCalls;
    expect(await refuses(runMeetingChapters(deps(), orgId, asUser('recorder'), meetingId))).toBe('TRANSCRIBE_RUNNING');
    expect(modelCalls).toBe(before);
    await sqlAdmin(`UPDATE crove_kernel.ai_run SET status = 'cancelled', finished_at = now() WHERE org_id = $1 AND id = $2`, [orgId, live.runId]);
    expect((await runMeetingChapters(deps(), orgId, asUser('recorder'), meetingId)).state).toBe('ready');
  });
});

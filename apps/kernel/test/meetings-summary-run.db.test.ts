// SPDX-License-Identifier: AGPL-3.0-only
// The recorder's Vy summarizing a meeting through the API's route logic (#2580, M6 part B2, ADR-0049 stage A) on a real database, with a fake model: who may start it
// (the recorder only, with vy.use, in their own org, with the deployment's switch on), that the run is bound to this meeting, that a model that never answers leaves the run
// failed with a fixed code, that a too long transcript is refused before any call, and that neither the transcript nor the answer reaches a log.
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
import { runMeetingSummary, type MeetingSummaryDeps } from '../src/member-vy-ports.ts';
import { TEST_MANIFESTS } from './invariant/fixtures/manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

const SECRET_LINE = 'Khách A hẹn gặp tại quán cà phê Bình Minh lúc 9 giờ';
const SECRET_ANSWER = 'Cuộc họp bàn việc gặp khách A';

suite('the recorder\'s Vy summary route (#2580, M6 part B2)', () => {
  const dbName = `crove_test_summary_run_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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

  const answer = JSON.stringify({ summary: SECRET_ANSWER + '.', decisions: ['Giữ giá cũ'], items: [{ title: 'Gửi báo giá', who: 'Hà', when: 'thứ sáu', seconds: 5 }], dropped: 0 });
  const model = (text: string | (() => Promise<string>)): ModelPort => ({
    generate: async () => {
      modelCalls += 1;
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
    for (const key of ['owner', 'recorder', 'attendee', 'viewer', 'foreign', 'nouse']) users[key] = await upsertIdentity(createDb(pool), { issuer: 'summary-run', subject: key, email: `${key}@summary-run.test`, name: key === 'recorder' ? 'Hà' : null });
    orgId = (await createOrg(runtime, asUser('owner'), 'Tóm tắt chạy')).orgId;
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

  it('runs end to end: the run is bound to the meeting, the result is stored for the recorder, and the recorder copies it into a tainted draft', async () => {
    const meetingId = await seedMeeting('recorder');
    const out = await runMeetingSummary(deps(), orgId, asUser('recorder'), meetingId);
    expect(out).toMatchObject({ meetingId, state: 'ready', errorCode: null });
    expect(modelCalls).toBe(1);
    expect(await runs(meetingId)).toEqual([{ status: 'ready', error_code: null, subject_type: 'meeting', subject_id: meetingId, feature: 'meetings.summary' }]);
    expect(await exec('recorder', 'meetings.summary.copy_result', { meetingId, runId: out.runId })).toMatchObject({ items: 1, decisions: 1 });
    // Nothing the member said or the model answered reached a log.
    const everything = logged.join('\n');
    expect(everything).not.toContain('Bình Minh');
    expect(everything).not.toContain(SECRET_ANSWER);
    expect(everything).not.toContain('Giữ giá cũ');
  });

  it('refuses a member without vy.use, a member who is not the recorder, another org and a switch that is off, before any model call and without a run', async () => {
    // A recorder whose vy.use was taken away by an owner: refused by run.start, after the recorder check and before any read of the transcript.
    const viewerMeeting = await seedMeeting('nouse');
    await exec('owner', 'kernel.member.permission.set', { userId: users.nouse, permission: 'vy.use', allowed: false });
    expect(await refuses(runMeetingSummary(deps(), orgId, asUser('nouse'), viewerMeeting))).toBe('VY_NOT_ALLOWED');
    // A viewer's role cannot ask for it at all.
    expect(await refuses(runMeetingSummary(deps(), orgId, asUser('viewer'), viewerMeeting))).not.toBeNull();
    const mine = await seedMeeting('recorder');
    expect(await refuses(runMeetingSummary(deps(), orgId, asUser('attendee'), mine))).toBe('MEETING_NOT_FOUND');
    await sqlAdmin(`INSERT INTO crove_meetings.meeting_reader (org_id, id, meeting_id, user_id) VALUES ($1, $2, $3, $4)`, [orgId, randomUUID(), mine, users.attendee]);
    expect(await refuses(runMeetingSummary(deps(), orgId, asUser('attendee'), mine))).toBe('FORBIDDEN');
    // Another org's member names this org's meeting in their own org: no such meeting there.
    expect(await refuses(runMeetingSummary(deps(), otherOrgId, asUser('foreign'), mine))).toBe('MEETING_NOT_FOUND');
    setSummaryEnabled(false);
    expect(await refuses(runMeetingSummary(deps(), orgId, asUser('recorder'), mine))).toBe('SUMMARY_OFF');
    setSummaryEnabled(true);
    expect(await refuses(runMeetingSummary(deps({ model: null }), orgId, asUser('recorder'), mine))).toBe('SUMMARY_OFF');
    expect(modelCalls).toBe(0);
    for (const id of [viewerMeeting, mine]) expect(await runs(id)).toEqual([]);
  });

  it('refuses a meeting with no transcript and a run of another meeting\'s result', async () => {
    const empty = await seedMeeting('recorder', []);
    expect(await refuses(runMeetingSummary(deps(), orgId, asUser('recorder'), empty))).toBe('TRANSCRIPT_EMPTY');
    const a = await seedMeeting('recorder');
    const b = await seedMeeting('recorder');
    const done = await runMeetingSummary(deps(), orgId, asUser('recorder'), a);
    // The result of the run for a cannot be copied into b.
    expect(await refuses(exec('recorder', 'meetings.summary.copy_result', { meetingId: b, runId: done.runId }))).toBe('SUMMARY_RESULT_NOT_FOUND');
  });

  it('leaves the run failed with a fixed code when the model never answers, and stores nothing to copy', async () => {
    const meetingId = await seedMeeting('recorder');
    const started = Date.now();
    const out = await runMeetingSummary(deps({ model: model(() => new Promise<string>(() => undefined)), timeoutMs: 150 }), orgId, asUser('recorder'), meetingId);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(out).toMatchObject({ state: 'failed', errorCode: 'SUMMARY_TIMEOUT' });
    expect(await runs(meetingId)).toEqual([{ status: 'failed', error_code: 'SUMMARY_TIMEOUT', subject_type: 'meeting', subject_id: meetingId, feature: 'meetings.summary' }]);
    expect(await refuses(exec('recorder', 'meetings.summary.copy_result', { meetingId, runId: out.runId }))).toBe('SUMMARY_RESULT_NOT_READY');
  });

  it('names every other failure by a fixed code: a spent budget, an unusable answer, an empty one, a model that fails, a transcript over the cap', async () => {
    const meetingId = await seedMeeting('recorder');
    const code = async (port: ModelPort, id = meetingId) => (await runMeetingSummary(deps({ model: port }), orgId, asUser('recorder'), id)).errorCode;
    expect(await code({ generate: async () => { throw new AiBudgetExhaustedError('org', null); } })).toBe('AI_BUDGET_EXHAUSTED');
    expect(await code(model('xin lỗi, tôi không làm được'))).toBe('SUMMARY_UNPARSABLE');
    expect(await code(model('{"summary":"","decisions":[],"items":[]}'))).toBe('SUMMARY_EMPTY');
    expect(await code({ generate: async () => { throw new Error(`provider said: ${SECRET_LINE}`); } })).toBe('SUMMARY_FAILED');
    const long = await seedMeeting('recorder', Array.from({ length: 20 }, (_, i): [number, number, string] => [i * 10, i * 10 + 9, 'x'.repeat(3900)]));
    const before = modelCalls;
    expect(await code(model(answer), long)).toBe('SUMMARY_TOO_LONG');
    expect(modelCalls).toBe(before);
    // A failure's own message (which may quote the transcript) is never logged, only its fixed code.
    expect(logged.join('\n')).not.toContain('Bình Minh');
    expect(logged.join('\n')).toContain('SUMMARY_FAILED');
  });

  it('spends no rate on a member who is refused: only the recorder\'s own asks count against the org\'s few a minute', async () => {
    const meetingId = await seedMeeting('recorder');
    await sqlAdmin(`INSERT INTO crove_meetings.meeting_reader (org_id, id, meeting_id, user_id) VALUES ($1, $2, $3, $4)`, [orgId, randomUUID(), meetingId, users.attendee]);
    const budget = new DraftBudget({ perUserPerMinute: 100, perOrgPerMinute: 1 });
    for (let i = 0; i < 3; i += 1) expect(await refuses(runMeetingSummary(deps({ budget }), orgId, asUser('attendee'), meetingId))).toBe('FORBIDDEN');
    expect((await runMeetingSummary(deps({ budget }), orgId, asUser('recorder'), meetingId)).state).toBe('ready');
    expect(modelCalls).toBe(1);
  });

  it('is rate limited per member, one at a time', async () => {
    const meetingId = await seedMeeting('recorder');
    const budget = new DraftBudget({ perUserPerMinute: 1, perOrgPerMinute: 100 });
    expect((await runMeetingSummary(deps({ budget }), orgId, asUser('recorder'), meetingId)).state).toBe('ready');
    expect(await refuses(runMeetingSummary(deps({ budget }), orgId, asUser('recorder'), meetingId))).toBe('SUMMARY_BUSY');
  });
});

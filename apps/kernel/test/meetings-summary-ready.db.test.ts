// SPDX-License-Identifier: AGPL-3.0-only
// The "minutes draft ready" notice (#3730) on a real database, with a fake model: when the recorder's summary run is stored as ready, the RECORDER gets one in-app notice and one email, and
// nobody else does; the notice and the mail hold a fixed line and the link, never a title or a word of the summary, a decision or an item (canary strings pin it); the notification setting
// turns off both; a replay of the same run writes and sends nothing more; a failed run, the notes run and a deployment with the AI off send nothing.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AiMeter } from '@ludy/agent';
import type { ModelPort } from '@ludy/agent/member-vy';
import { createDb, createPool } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import { Runtime } from '@ludy/kernel-runtime';
import { meetingsCommands, meetingsQueries, setSummaryEnabled } from '@ludy/mod-meetings';
import { DraftBudget } from '../src/ai-draft-limit.ts';
import { runMeetingSummary, runNotesEnhance, type MeetingSummaryDeps } from '../src/member-vy-ports.ts';
import { NOTIFY_COMMANDS } from '../src/worker.ts';
import { summaryReadyMailTemplate } from '../src/summary-ready-mail.ts';
import { TEST_MANIFESTS } from './invariant/fixtures/manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

const SECRET_LINE = 'Khách A hẹn gặp tại quán cà phê Bình Minh lúc 9 giờ';
const SECRET_ANSWER = 'Cuộc họp bàn việc gặp khách A';

suite('the "minutes draft ready" notice (#3730)', () => {
  const dbName = `ludy_test_summary_ready_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  const pools: pg.Pool[] = [];
  let orgId = '';
  let otherOrgId = '';
  let runtime: Runtime;
  let worker: Runtime;
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
      `INSERT INTO ludy_meetings.meeting (org_id, id, title, language, started_at, ended_at, length_seconds, recorder_user_id, visibility, status, consent_method, consent_confirmed_by, consent_confirmed_at, consent_notice_version, audio_retention_date, text_retention_date)
       VALUES ($1, $2, 'Họp tuần', 'vi', '2026-11-10T03:00:00Z', '2026-11-10T03:30:00Z', 1800, $3, 'attendees', 'ready', 'told_at_start', $3, now(), '1.0', current_date + 30, current_date + 365)`,
      [org, meetingId, users[recorder]],
    );
    if (segments.length > 0 && recorder === 'viewer') {
      // A viewer cannot store a transcript through the command: a segment is put there directly (the case is a recorder who then lost vy.use).
      await sqlAdmin(`INSERT INTO ludy_meetings.transcript_segment (org_id, id, meeting_id, start_seconds, end_seconds, speaker_label, text, stage) VALUES ($1, $2, $3, 0, 10, 'Hà', 'Một dòng', 'draft')`, [org, randomUUID(), meetingId]);
    } else if (segments.length > 0) {
      await exec(recorder, 'meetings.transcript.draft_store', { meetingId, segments: segments.map(([startSeconds, endSeconds, text]) => ({ startSeconds, endSeconds, speakerLabel: 'Hà', text })) }, org);
    }
    return meetingId;
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
    await setRolePasswords(adminUrl, { ludy_app: 'test-app-pw', ludy_worker: 'test-worker-pw' });
    const url = new URL(adminUrl);
    url.username = 'ludy_app';
    url.password = 'test-app-pw';
    const pool = createPool({ connectionString: url.toString(), max: 4 });
    pools.push(pool);
    runtime = new Runtime(createDb(pool), { manifests: TEST_MANIFESTS }).register({
      commands: [...kernelCommands, ...meetingsCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...meetingsQueries],
    });
    const workerUrl = new URL(adminUrl);
    workerUrl.username = 'ludy_worker';
    workerUrl.password = 'test-worker-pw';
    const workerPool = createPool({ connectionString: workerUrl.toString(), max: 4 });
    pools.push(workerPool);
    worker = new Runtime(createDb(workerPool), { manifests: TEST_MANIFESTS }).register({
      commands: [...kernelCommands, ...meetingsCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...meetingsQueries],
    });
    setSummaryEnabled(true);
    for (const key of ['owner', 'recorder', 'attendee', 'viewer', 'foreign', 'nouse']) users[key] = await upsertIdentity(createDb(pool), { issuer: 'summary-run', subject: key, email: `${key}@summary-run.test`, name: key === 'recorder' ? 'Hà' : null });
    orgId = (await createOrg(runtime, asUser('owner'), 'Tóm tắt chạy')).orgId;
    otherOrgId = (await createOrg(runtime, asUser('foreign'), 'Org khác')).orgId;
    await sqlAdmin(`INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member'), ($1, $4, 'viewer'), ($1, $5, 'member')`, [orgId, users.recorder, users.attendee, users.viewer, users.nouse]);
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


  const KIND = 'meetings.summary_ready';
  const TEMPLATE = 'meetings.summary_ready';
  const notices = async (meetingId?: string) =>
    (
      await sqlAdmin<{ user_id: string; subject_type: string | null; subject_id: string | null; detail: Record<string, string>; dedupe_key: string }>(
        `SELECT user_id, subject_type, subject_id, detail, dedupe_key FROM ludy_kernel.notification WHERE org_id = $1 AND kind = $2 ${meetingId ? 'AND subject_id = $3' : ''} ORDER BY created_at`,
        meetingId ? [orgId, KIND, meetingId] : [orgId, KIND],
      )
    ).rows;
  const mails = async (meetingId?: string) =>
    (
      await sqlAdmin<{ to_address: string; subject: string | null; source: string; source_id: string | null; payload: Record<string, unknown> | null; status: string }>(
        `SELECT to_address, subject, source, source_id, payload, status FROM ludy_kernel.mail_message WHERE org_id = $1 AND template_key = $2 ${meetingId ? 'AND source_id = $3' : ''} ORDER BY created_at`,
        meetingId ? [orgId, TEMPLATE, meetingId] : [orgId, TEMPLATE],
      )
    ).rows;
  // The words of the draft the notice must never carry: the summary, the decision and the item the fake model wrote, and a line of the transcript.
  const CANARIES = [SECRET_ANSWER, 'Giữ giá cũ', 'Gửi báo giá', 'Bình Minh', 'thứ sáu'];
  const noCanary = (text: string) => {
    for (const word of CANARIES) expect(text).not.toContain(word);
  };

  // The worker's part: the relay routes each event of the type to the dispatch command in NOTIFY_COMMANDS, which runs in the system's context with the event's id only.
  const events = async (meetingId: string) =>
    (await sqlAdmin<{ id: string; payload: Record<string, unknown> }>(`SELECT id, payload FROM ludy_kernel.outbox_event WHERE org_id = $1 AND type = 'meetings.summary.ready' AND payload ->> 'meetingId' = $2 ORDER BY created_at`, [orgId, meetingId])).rows;
  const dispatch = async (eventId: string) => {
    const route = NOTIFY_COMMANDS.get('meetings.summary.ready');
    expect(route).toEqual({ module: 'meetings', command: 'meetings.summary.ready_notice' });
    return worker.execute<{ notified: boolean; mailed: boolean }>(route?.command as string, { eventId }, { actor: { type: 'system', component: 'test.summary-ready' }, orgId });
  };
  const dispatchAll = async (meetingId: string) => {
    const out: Array<{ notified: boolean; mailed: boolean }> = [];
    for (const e of await events(meetingId)) out.push(await dispatch(e.id));
    return out;
  };

  it('tells the recorder once, in-app and by email, with the link and no word of the draft or the title', async () => {
    const meetingId = await seedMeeting('recorder');
    // Another reader of the meeting: a member added as a reader, who must get nothing.
    await sqlAdmin('INSERT INTO ludy_meetings.meeting_reader (org_id, id, meeting_id, user_id) VALUES ($1, $2, $3, $4)', [orgId, randomUUID(), meetingId, users.attendee]);
    const out = await runMeetingSummary(deps(), orgId, asUser('recorder'), meetingId);
    expect(out).toMatchObject({ state: 'ready', errorCode: null });
    // The run wrote one event with ids and the language only; nothing is told until the worker dispatches it.
    const queued = await events(meetingId);
    expect(queued).toHaveLength(1);
    expect(queued[0]?.payload).toEqual({ meetingId, runId: out.runId, recorderUserId: users.recorder, language: 'vi' });
    noCanary(JSON.stringify(queued));
    expect(JSON.stringify(queued)).not.toContain('Họp tuần');
    expect(await notices(meetingId)).toEqual([]);
    expect(await dispatchAll(meetingId)).toEqual([{ notified: true, mailed: true }]);
    // Browser push (#3736): the worker asks which notices this event wrote and queues a push job for each; the recorder's notice is the one, a replay of the event names it no more than once a day, and the line it pushes has no word of the draft.
    const pushed = await worker.query<string[]>('kernel.push.pending', { eventId: queued[0]?.id }, { actor: { type: 'system', component: 'test.summary-ready' }, orgId });
    expect(pushed).toHaveLength(1);
    // One in-app notice, to the recorder, about this meeting, keyed by the run, with an empty detail.
    expect(await notices(meetingId)).toEqual([{ user_id: users.recorder, subject_type: 'meetings.meeting', subject_id: meetingId, detail: {}, dedupe_key: `summary:${out.runId}` }]);
    // One mail, to the recorder's address, with exactly the merge data the template needs.
    const sent = await mails(meetingId);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to_address: 'recorder@summary-run.test', source: 'meetings.summary_ready', source_id: meetingId, status: 'queued' });
    expect(Object.keys(sent[0]?.payload ?? {}).sort()).toEqual(['lang', 'org', 'path']);
    expect(String(sent[0]?.payload?.path)).toMatch(new RegExp(`^/o/[a-z0-9-]+/meetings/${meetingId}$`));
    // No word of the draft and no title is in the notice, the stored mail (subject included) or the rendered one.
    const rendered = await summaryReadyMailTemplate.render({ messageId: randomUUID(), subject: sent[0]?.subject ?? null, payload: sent[0]?.payload ?? {}, publicUrl: 'https://ludy.test', inboundAddress: null, brand: 'Ludy', execute: async () => undefined as never });
    expect(rendered?.text).toContain(`https://ludy.test/o/`);
    expect(rendered?.text).toContain(`/meetings/${meetingId}`);
    for (const copy of [JSON.stringify(await notices(meetingId)), JSON.stringify(sent), JSON.stringify(rendered)]) {
      noCanary(copy);
      expect(copy).not.toContain('Họp tuần');
    }
    // Nobody else was told, in-app or by mail.
    expect((await notices()).filter((n) => n.user_id !== users.recorder)).toEqual([]);
    expect((await mails()).filter((m) => m.to_address !== 'recorder@summary-run.test')).toEqual([]);
    // And the draft itself is still the recorder's to copy: the notice did not touch it.
    expect(await exec('recorder', 'meetings.summary.copy_result', { meetingId, runId: out.runId })).toMatchObject({ items: 1, decisions: 1 });
  });

  it('is one notice per finished run: dispatching the same event again writes and sends nothing more, and a second run is a second notice', async () => {
    const meetingId = await seedMeeting('recorder');
    const first = await runMeetingSummary(deps(), orgId, asUser('recorder'), meetingId);
    const [event] = await events(meetingId);
    expect(await dispatch(event?.id as string)).toEqual({ notified: true, mailed: true });
    expect(await dispatch(event?.id as string)).toEqual({ notified: false, mailed: false });
    expect(await notices(meetingId)).toHaveLength(1);
    expect(await mails(meetingId)).toHaveLength(1);
    const second = await runMeetingSummary(deps(), orgId, asUser('recorder'), meetingId);
    expect(second.runId).not.toBe(first.runId);
    expect(await dispatchAll(meetingId)).toEqual([{ notified: false, mailed: false }, { notified: true, mailed: true }]);
    expect((await notices(meetingId)).map((n) => n.dedupe_key)).toEqual([`summary:${first.runId}`, `summary:${second.runId}`]);
    expect(await mails(meetingId)).toHaveLength(2);
  });

  it('turning the kind off in the notification settings turns off the in-app notice and the email, and the run still finishes', async () => {
    await sqlAdmin(`INSERT INTO ludy_kernel.notification_mute (org_id, user_id, kind) VALUES ($1, $2, $3)`, [orgId, users.recorder, KIND]);
    try {
      const meetingId = await seedMeeting('recorder');
      const out = await runMeetingSummary(deps(), orgId, asUser('recorder'), meetingId);
      expect(out.state).toBe('ready');
      expect(await dispatchAll(meetingId)).toEqual([{ notified: false, mailed: false }]);
      // Nothing was written, so nothing is pushed either: the one switch covers the in-app line, the mail and the push.
      expect(await worker.query<string[]>('kernel.push.pending', { eventId: (await events(meetingId))[0]?.id }, { actor: { type: 'system', component: 'test.summary-ready' }, orgId })).toEqual([]);
      expect(await notices(meetingId)).toEqual([]);
      expect(await mails(meetingId)).toEqual([]);
    } finally {
      await sqlAdmin(`DELETE FROM ludy_kernel.notification_mute WHERE org_id = $1 AND user_id = $2 AND kind = $3`, [orgId, users.recorder, KIND]);
    }
  });

  it('a second call for the same run, a disabled account and an event of another type send no second mail, no mail, and nothing', async () => {
    const meetingId = await seedMeeting('recorder');
    const out = await runMeetingSummary(deps(), orgId, asUser('recorder'), meetingId);
    // The same run announced twice (a retry of the API): two events, one notice, one mail.
    await exec('recorder', 'meetings.summary.ready', { meetingId, runId: out.runId });
    expect(await dispatchAll(meetingId)).toEqual([{ notified: true, mailed: true }, { notified: false, mailed: false }]);
    expect(await notices(meetingId)).toHaveLength(1);
    expect(await mails(meetingId)).toHaveLength(1);
    // An event that is not the ready event writes nothing.
    const other = await sqlAdmin<{ id: string }>(`SELECT id FROM ludy_kernel.outbox_event WHERE org_id = $1 AND type <> 'meetings.summary.ready' LIMIT 1`, [orgId]);
    if (other.rows[0]) expect(await dispatch(other.rows[0].id)).toEqual({ notified: false, mailed: false });
    // A recorder whose account is disabled gets the in-app notice (it is theirs when they return) and no mail.
    const meeting2 = await seedMeeting('recorder');
    await runMeetingSummary(deps(), orgId, asUser('recorder'), meeting2);
    await sqlAdmin('UPDATE ludy_kernel.user_account SET disabled_at = now() WHERE id = $1', [users.recorder]);
    try {
      expect(await dispatchAll(meeting2)).toEqual([{ notified: true, mailed: false }]);
      expect(await mails(meeting2)).toEqual([]);
    } finally {
      await sqlAdmin('UPDATE ludy_kernel.user_account SET disabled_at = NULL WHERE id = $1', [users.recorder]);
    }
  });

  it('writes no event for a failed run, for the notes run, or when the AI is off', async () => {
    const failed = await seedMeeting('recorder');
    expect(await runMeetingSummary(deps({ model: model('not an answer') }), orgId, asUser('recorder'), failed)).toMatchObject({ state: 'failed' });
    const notes = await seedMeeting('recorder');
    await exec('recorder', 'meetings.notes.save', { meetingId: notes, body: 'báo giá khách A\nNam gửi trước thứ sáu\nhỏi lại chiết khấu' });
    expect(await runNotesEnhance(deps({ model: model(JSON.stringify({ sections: [{ key: 'all', lines: [{ note: 1 }, { text: 'Khách A hẹn gặp lúc 9 giờ.', seconds: 5 }, { note: 2 }, { note: 3 }] }] })) }), orgId, asUser('recorder'), notes)).toMatchObject({ state: 'ready' });
    const off = await seedMeeting('recorder');
    setSummaryEnabled(false);
    expect(await refuses(runMeetingSummary(deps(), orgId, asUser('recorder'), off))).toBe('SUMMARY_OFF');
    expect(await refuses(runMeetingSummary(deps({ model: null }), orgId, asUser('recorder'), off))).toBe('SUMMARY_OFF');
    for (const id of [failed, notes, off]) {
      expect(await events(id)).toEqual([]);
      expect(await notices(id)).toEqual([]);
      expect(await mails(id)).toEqual([]);
    }
  });

  it('is the recorder\'s command and the system\'s dispatch alone: nobody else can raise or write a notice', async () => {
    const meetingId = await seedMeeting('recorder');
    const ref = { meetingId, runId: randomUUID() };
    // A member who is not the recorder (even one who reads the meeting), a viewer and the owner of another org are refused, and nothing is queued.
    await sqlAdmin('INSERT INTO ludy_meetings.meeting_reader (org_id, id, meeting_id, user_id) VALUES ($1, $2, $3, $4)', [orgId, randomUUID(), meetingId, users.attendee]);
    expect(await refuses(exec('attendee', 'meetings.summary.ready', ref))).toBe('FORBIDDEN');
    expect(await refuses(exec('viewer', 'meetings.summary.ready', ref))).not.toBeNull();
    expect(await refuses(exec('foreign', 'meetings.summary.ready', ref, otherOrgId))).not.toBeNull();
    expect(await events(meetingId)).toEqual([]);
    // A user cannot run the dispatch, with a real event id or not.
    await exec('recorder', 'meetings.summary.ready', ref);
    const [event] = await events(meetingId);
    expect(await refuses(exec('recorder', 'meetings.summary.ready_notice', { eventId: event?.id }))).not.toBeNull();
    expect(await refuses(exec('owner', 'meetings.summary.ready_notice', { eventId: event?.id }))).not.toBeNull();
    expect(await notices(meetingId)).toEqual([]);
    expect(await mails(meetingId)).toEqual([]);
  });

  it('keeps no title, address or text of the draft in the audit rows of the notice', async () => {
    const meetingId = await seedMeeting('recorder');
    const out = await runMeetingSummary(deps(), orgId, asUser('recorder'), meetingId);
    await dispatchAll(meetingId);
    const audit = await sqlAdmin<{ command: string; detail: unknown }>(`SELECT command, detail FROM ludy_kernel.audit_event WHERE org_id = $1 AND command IN ('meetings.summary.ready', 'meetings.summary.ready_notice') AND detail ->> 'meetingId' = $2`, [orgId, meetingId]);
    expect(audit.rows.map((r) => r.command).sort()).toEqual(['meetings.summary.ready', 'meetings.summary.ready_notice']);
    const text = JSON.stringify(audit.rows);
    expect(text).toContain(out.runId);
    expect(text).not.toContain('Họp tuần');
    expect(text).not.toContain('summary-run.test');
    noCanary(text);
  });
});

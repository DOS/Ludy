// SPDX-License-Identifier: AGPL-3.0-only
// "Ghi chú của tôi" and "Viết lại đầy đủ" on a real database (Meetings A5, #3163, plan docs/plan/meetings-integrations.md section 4.4), with a fake model: the recorder's rough notes are theirs alone
// (every other member, an owner included, is refused, and the table shows them nothing), they go with the meeting, and the recorder's Vy expands them with the transcript in the same run family as the
// summary: the recorder's own lines come back verbatim, every added line rests on a second of the transcript, the result is private until the recorder copies it into a tainted draft, and nothing is shared.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AiMeter } from '@crove/agent';
import type { PersonalDataErasure, PersonalDataResult } from '@crove/kernel-contract';
import type { ModelPort } from '@crove/agent/member-vy';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { meetingsCommands, meetingsQueries, setSummaryEnabled } from '@crove/mod-meetings';
import { DraftBudget } from '../src/ai-draft-limit.ts';
import { runMeetingSummary, runNotesEnhance, type MeetingSummaryDeps } from '../src/member-vy-ports.ts';
import { TEST_MANIFESTS } from './invariant/fixtures/manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

const NOTES = 'báo giá khách A\nNam gửi trước thứ sáu\nhỏi lại chiết khấu';

suite('the recorder\'s rough notes and Vy\'s expansion of them (A5, #3163)', () => {
  const dbName = `crove_test_notes_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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

  let modelCalls = 0;
  const prompts: string[] = [];
  afterEach(() => {
    modelCalls = 0;
    prompts.length = 0;
    setSummaryEnabled(true);
  });
  const model = (text: string): ModelPort => ({
    generate: async (_who, prompt) => {
      modelCalls += 1;
      prompts.push(`${prompt.system}\n${prompt.user}`);
      return { text, usage: { inputTokens: 100, outputTokens: 30 } };
    },
  });
  const meter: AiMeter = { admit: async () => undefined, record: async () => undefined };
  const deps = (answer: string): MeetingSummaryDeps => ({ runtime, model: model(answer), meter: () => meter, budget: new DraftBudget({ perUserPerMinute: 100, perOrgPerMinute: 100 }), timeoutMs: 2000 });

  // Segments: 0-10 "Khách A hẹn gặp lúc 9 giờ", 10-20 "Nam sẽ gửi báo giá trước thứ sáu".
  async function seedMeeting(recorder: string, readers: string[] = ['attendee']): Promise<string> {
    const meetingId = randomUUID();
    await sqlAdmin(
      `INSERT INTO crove_meetings.meeting (org_id, id, title, language, started_at, ended_at, length_seconds, recorder_user_id, visibility, status, consent_method, consent_confirmed_by, consent_confirmed_at, consent_notice_version, audio_retention_date, text_retention_date)
       VALUES ($1, $2, 'Họp tuần', 'vi', '2026-11-10T03:00:00Z', '2026-11-10T03:30:00Z', 1800, $3, 'attendees', 'ready', 'told_at_start', $3, now(), '1.0', current_date + 30, current_date + 365)`,
      [orgId, meetingId, users[recorder]],
    );
    for (const reader of readers) await sqlAdmin(`INSERT INTO crove_meetings.meeting_reader (org_id, id, meeting_id, user_id) VALUES ($1, $2, $3, $4)`, [orgId, randomUUID(), meetingId, users[reader]]);
    await exec(recorder, 'meetings.transcript.draft_store', {
      meetingId,
      segments: [
        { startSeconds: 0, endSeconds: 10, speakerLabel: 'Hà', text: 'Khách A hẹn gặp lúc 9 giờ' },
        { startSeconds: 10, endSeconds: 20, speakerLabel: 'Hà', text: 'Nam sẽ gửi báo giá trước thứ sáu' },
      ],
    });
    return meetingId;
  }
  const noteRows = async (meetingId: string) => (await sqlAdmin<{ body: string }>(`SELECT body FROM crove_meetings.meeting_note WHERE org_id = $1 AND meeting_id = $2`, [orgId, meetingId])).rows;
  type Preview = { template: string; dropped: number; enhanced: { sections: Array<{ key: string | null; lines: Array<{ own: boolean; text: string; seconds: number | null }> }> } };
  const answer = (lines: unknown[], key = 'all') => JSON.stringify({ sections: [{ key, lines }] });

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
    for (const key of ['owner', 'recorder', 'attendee', 'stranger']) users[key] = await upsertIdentity(createDb(pool), { issuer: 'notes', subject: key, email: `${key}@notes.test`, name: key === 'recorder' ? 'Hà' : null });
    orgId = (await createOrg(runtime, asUser('owner'), 'Ghi chú')).orgId;
    await sqlAdmin(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member'), ($1, $4, 'member')`, [orgId, users.recorder, users.attendee, users.stranger]);
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

  it('saves, replaces and clears the notes for the recorder alone, with no AI at all', async () => {
    setSummaryEnabled(false);
    const meetingId = await seedMeeting('recorder');
    expect(await query('recorder', 'meetings.notes.get', { meetingId })).toMatchObject({ body: '', updatedAt: null });
    expect(await exec('recorder', 'meetings.notes.save', { meetingId, body: `  ${NOTES}  ` })).toEqual({ meetingId, saved: true });
    expect(await query('recorder', 'meetings.notes.get', { meetingId })).toMatchObject({ body: NOTES });
    await exec('recorder', 'meetings.notes.save', { meetingId, body: 'một dòng mới' });
    expect((await noteRows(meetingId)).map((r) => r.body)).toEqual(['một dòng mới']);
    expect(await exec('recorder', 'meetings.notes.save', { meetingId, body: '   ' })).toEqual({ meetingId, saved: false });
    expect(await noteRows(meetingId)).toEqual([]);
    // Too long for the contract.
    expect(await refuses(exec('recorder', 'meetings.notes.save', { meetingId, body: 'a'.repeat(6001) }))).not.toBeNull();
  });

  it('shows the notes to no one but the recorder: an attendee, an owner, a member outside the meeting, and the table itself', async () => {
    const meetingId = await seedMeeting('recorder');
    await exec('recorder', 'meetings.notes.save', { meetingId, body: NOTES });
    expect(await refuses(query('attendee', 'meetings.notes.get', { meetingId }))).toBe('FORBIDDEN');
    expect(await refuses(exec('attendee', 'meetings.notes.save', { meetingId, body: 'của tôi' }))).toBe('FORBIDDEN');
    expect(await refuses(query('stranger', 'meetings.notes.get', { meetingId }))).toBe('MEETING_NOT_FOUND');
    // The owner of the org cannot read an attendees-only meeting at all.
    expect(await refuses(query('owner', 'meetings.notes.get', { meetingId }))).toBe('MEETING_NOT_FOUND');
    expect(await refuses(exec('owner', 'meetings.notes.save', { meetingId, body: 'của chủ' }))).toBe('MEETING_NOT_FOUND');
    expect((await noteRows(meetingId)).map((r) => r.body)).toEqual([NOTES]);
    // An attendee's note of the same meeting is never made: they cannot write the table (the command refused above), and the audit row names the meeting and a length, not the text.
    const audit = await sqlAdmin<{ detail: unknown }>(`SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'meetings.notes.save' AND outcome = 'ok'`, [orgId]);
    expect(JSON.stringify(audit.rows)).not.toContain('Nam gửi');
  });

  it('goes with its meeting', async () => {
    const meetingId = await seedMeeting('recorder');
    await exec('recorder', 'meetings.notes.save', { meetingId, body: NOTES });
    await exec('recorder', 'meetings.meeting.delete', { meetingId });
    expect(await noteRows(meetingId)).toEqual([]);
  });

  // The finder (L5): a value in the recorder's own notes is listed where the actor is the recorder (row security as for every table); the notes of another recorder are counted for the owner per
  // recorder, never listed and never shown. The org is the data controller: the owner's erasure redacts the value in EVERY recorder's notes and reports the count per recorder.
  it('finds a value in the notes (lists the owner\'s own, counts another recorder\'s without showing them) and an erasure by the owner redacts every recorder\'s notes, counted per recorder', async () => {
    const email = 'ghi.chu.rieng@congty.example';
    const own = await seedMeeting('owner');
    await exec('owner', 'meetings.notes.save', { meetingId: own, body: `gửi hợp đồng cho ${email}\nmột dòng khác` });
    const theirs = await seedMeeting('recorder');
    await exec('recorder', 'meetings.notes.save', { meetingId: theirs, body: `nhắc ${email} về báo giá\n${email} lần hai` });
    const clean = await seedMeeting('recorder');
    await exec('recorder', 'meetings.notes.save', { meetingId: clean, body: 'ghi chú không nhắc ai' });
    const find = () => runtime.execute<PersonalDataResult>('kernel.personal_data.find', { value: email }, { actor: asUser('owner'), orgId, idempotencyKey: randomUUID() });
    const found = await find();
    expect(found.matches.filter((m) => m.column.startsWith('crove_meetings.')).map((m) => m.column)).toEqual(['crove_meetings.meeting_note.body']);
    // The recorder's notes are counted for their recorder, with no text, no meeting and no title.
    expect(found.meetingText).toEqual([{ recorderUserId: users.recorder, meetings: 0, lines: 0, results: 0, items: 0, titles: 0, notes: 1 }]);
    expect(JSON.stringify(found)).not.toContain('nhắc');
    // A member who is not an owner cannot run the finder.
    const refused = await runtime.execute<PersonalDataResult>('kernel.personal_data.find', { value: email }, { actor: asUser('recorder'), orgId, idempotencyKey: randomUUID() }).then(
      () => 'ok',
      (error: unknown) => (error as { code?: string }).code ?? 'ERR',
    );
    expect(refused).not.toBe('ok');

    const mfa = { type: 'user' as const, userId: users.owner as string, aal: 'aal2' as const, sessionId: randomUUID(), mfaAt: Math.floor(Date.now() / 1000) };
    const erased = await runtime.execute<PersonalDataErasure>('kernel.personal_data.erase', { value: email }, { actor: mfa, orgId, idempotencyKey: randomUUID() });
    expect(erased.erased.find((e) => e.column === 'crove_meetings.meeting_note.body')?.rows).toBe(2);
    // Counted per recorder: the owner's own note and the member's note, no text and no meeting.
    expect(erased.meetingNotes?.slice().sort((a, b) => a.recorderUserId.localeCompare(b.recorderUserId))).toEqual(
      [
        { recorderUserId: users.owner as string, notes: 1 },
        { recorderUserId: users.recorder as string, notes: 1 },
      ].sort((a, b) => a.recorderUserId.localeCompare(b.recorderUserId)),
    );
    expect(JSON.stringify(erased)).not.toContain('nhắc');
    expect(erased.kept.some((k) => k.column.startsWith('crove_meetings.meeting_note'))).toBe(false);
    // Every mention is replaced, in the member's note too; the lines around it and an untouched note stay as written.
    expect((await noteRows(own)).map((r) => r.body)).toEqual(['gửi hợp đồng cho [đã xóa]\nmột dòng khác']);
    expect((await noteRows(theirs)).map((r) => r.body)).toEqual(['nhắc [đã xóa] về báo giá\n[đã xóa] lần hai']);
    expect((await noteRows(clean)).map((r) => r.body)).toEqual(['ghi chú không nhắc ai']);
    expect((await find()).meetingText).toEqual([]);
    // The audit row holds counts, never the value or the text.
    const audit = JSON.stringify((await sqlAdmin(`SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'kernel.personal_data.erase' ORDER BY id DESC LIMIT 1`, [orgId])).rows);
    expect(audit).not.toContain(email);
    expect(audit).not.toContain('nhắc');
  });

  it('expands the notes with the transcript: own lines verbatim, added lines on a real second, a private result the recorder reads and copies into a tainted draft', async () => {
    const meetingId = await seedMeeting('recorder');
    await exec('recorder', 'meetings.notes.save', { meetingId, body: NOTES });
    const ai = answer([{ note: 1 }, { text: 'Khách A hẹn gặp lúc 9 giờ.', seconds: 5 }, { note: 2 }, { text: 'Giảm thêm 30%.', seconds: 12 }, { note: 3 }]);
    const out = await runNotesEnhance(deps(ai), orgId, asUser('recorder'), meetingId);
    expect(out).toMatchObject({ meetingId, state: 'ready', errorCode: null });
    expect(modelCalls).toBe(1);
    // The model was given the notes numbered and the transcript, never asked to copy a note.
    expect(prompts[0]).toContain('1: báo giá khách A');
    expect(prompts[0]).toContain('Nam sẽ gửi báo giá trước thứ sáu');
    const preview = await query<Preview>('recorder', 'meetings.notes.preview', { meetingId, runId: out.runId });
    expect(preview.enhanced.sections[0]?.lines).toEqual([
      { own: true, text: 'báo giá khách A', seconds: null },
      { own: false, text: 'Khách A hẹn gặp lúc 9 giờ.', seconds: 5 },
      { own: true, text: 'Nam gửi trước thứ sáu', seconds: null },
      { own: true, text: 'hỏi lại chiết khấu', seconds: null },
    ]);
    // "Giảm thêm 30%" carried a figure nobody said: removed and counted.
    expect(preview.dropped).toBe(1);
    // Nobody else reads the result, and it is not shared by being made.
    expect(await refuses(query('attendee', 'meetings.notes.preview', { meetingId, runId: out.runId }))).toBe('FORBIDDEN');
    expect((await query<{ draft: unknown; published: unknown }>('attendee', 'meetings.result.get', { meetingId })).draft).toBeNull();
    await exec('recorder', 'meetings.summary.copy_result', { meetingId, runId: out.runId });
    const got = await query<{ draft: { summary: string; tainted: boolean; decisions: string[] } | null; published: unknown }>('recorder', 'meetings.result.get', { meetingId });
    expect(got.draft).toMatchObject({ summary: 'báo giá khách A\nKhách A hẹn gặp lúc 9 giờ.\nNam gửi trước thứ sáu\nhỏi lại chiết khấu', tainted: true, decisions: [] });
    expect(got.published).toBeNull();
    // A person approves: the attendee still reads nothing, and publishing needs the recorder's read first.
    expect(await refuses(exec('recorder', 'meetings.result.publish', { meetingId, confirmed: true }))).toBe('DRAFT_NOT_REVIEWED');
    expect((await query<{ draft: unknown }>('attendee', 'meetings.result.get', { meetingId })).draft).toBeNull();
  });

  it('fills the sections of the meeting\'s template and leaves the items a summary run suggested', async () => {
    const meetingId = await seedMeeting('recorder');
    await exec('recorder', 'meetings.minutes.set_template', { meetingId, summaryTemplate: 'briefing' });
    // A summary run first, whose item must survive the copy of the expansion.
    const summary = await runMeetingSummary(deps(JSON.stringify({ sections: [{ key: 'plan', text: 'Nam sẽ gửi báo giá trước thứ sáu.' }], decisions: [], items: [{ title: 'Gửi báo giá', who: 'Nam', when: 'thứ sáu', seconds: 15 }] })), orgId, asUser('recorder'), meetingId);
    expect(summary.state).toBe('ready');
    await exec('recorder', 'meetings.summary.copy_result', { meetingId, runId: summary.runId });
    await exec('recorder', 'meetings.notes.save', { meetingId, body: NOTES });
    const out = await runNotesEnhance(
      deps(JSON.stringify({ sections: [{ key: 'plan', lines: [{ note: 2 }, { text: 'Nam sẽ gửi báo giá trước thứ sáu.', seconds: 15 }] }, { key: 'progress', lines: [{ note: 1 }] }, { key: 'nope', lines: [{ note: 3 }] }] })),
      orgId,
      asUser('recorder'),
      meetingId,
    );
    expect(prompts.at(-1)).toContain('key "progress" (Kết quả công việc kỳ trước)');
    const preview = await query<Preview>('recorder', 'meetings.notes.preview', { meetingId, runId: out.runId });
    expect(preview.template).toBe('briefing');
    expect(preview.enhanced.sections.map((s) => s.key)).toEqual(['progress', 'plan']);
    await exec('recorder', 'meetings.summary.copy_result', { meetingId, runId: out.runId });
    const got = await query<{ draft: { summary: string } | null; items: Array<{ title: string; stage: string }> }>('recorder', 'meetings.result.get', { meetingId });
    expect(got.draft?.summary).toBe('Kết quả công việc kỳ trước\nbáo giá khách A\n\nKế hoạch kỳ tới\nNam gửi trước thứ sáu\nNam sẽ gửi báo giá trước thứ sáu.\nhỏi lại chiết khấu');
    expect(got.items.map((i) => i.title)).toEqual(['Gửi báo giá']);
    // The template changed since the run: not copied.
    await exec('recorder', 'meetings.minutes.set_template', { meetingId, summaryTemplate: 'customer' });
    const again = await runNotesEnhance(deps(answer([{ note: 1 }, { text: 'Khách A hẹn gặp lúc 9 giờ.', seconds: 5 }], 'needs')), orgId, asUser('recorder'), meetingId);
    await exec('recorder', 'meetings.minutes.set_template', { meetingId, summaryTemplate: 'supplier' });
    expect(await refuses(exec('recorder', 'meetings.summary.copy_result', { meetingId, runId: again.runId }))).toBe('SUMMARY_TEMPLATE_CHANGED');
  });

  it('refuses before any run or model call: no notes, a member who is not the recorder, a switch that is off', async () => {
    const meetingId = await seedMeeting('recorder');
    expect(await refuses(runNotesEnhance(deps('{}'), orgId, asUser('recorder'), meetingId))).toBe('NOTES_EMPTY');
    await exec('recorder', 'meetings.notes.save', { meetingId, body: NOTES });
    expect(await refuses(runNotesEnhance(deps('{}'), orgId, asUser('attendee'), meetingId))).toBe('FORBIDDEN');
    setSummaryEnabled(false);
    expect(await refuses(runNotesEnhance(deps('{}'), orgId, asUser('recorder'), meetingId))).toBe('SUMMARY_OFF');
    expect(modelCalls).toBe(0);
    const runs = await sqlAdmin<{ n: string }>(`SELECT count(*)::text AS n FROM crove_kernel.member_vy_result WHERE org_id = $1 AND subject_id = $2`, [orgId, meetingId]);
    expect(runs.rows[0]?.n).toBe('0');
  });

  it('refuses an expansion that added nothing the transcript supports, with a fixed code, and a preview of a run that is not an expansion', async () => {
    const meetingId = await seedMeeting('recorder');
    await exec('recorder', 'meetings.notes.save', { meetingId, body: NOTES });
    const empty = await runNotesEnhance(deps(answer([{ note: 1 }, { note: 2 }, { note: 3 }])), orgId, asUser('recorder'), meetingId);
    expect(empty).toMatchObject({ state: 'failed', errorCode: 'SUMMARY_EMPTY' });
    const plain = await runMeetingSummary(deps(JSON.stringify({ summary: 'Họp báo giá.', decisions: [], items: [] })), orgId, asUser('recorder'), meetingId);
    expect(await refuses(query('recorder', 'meetings.notes.preview', { meetingId, runId: plain.runId }))).toBe('SUMMARY_RESULT_NOT_FOUND');
    expect(await refuses(query('recorder', 'meetings.notes.preview', { meetingId, runId: randomUUID() }))).toBe('SUMMARY_RESULT_NOT_FOUND');
  });
});

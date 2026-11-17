// SPDX-License-Identifier: AGPL-3.0-only
// Speaker names suggested by the recorder's Vy (#3502) on a real database, with a fake model: the summary run is told the names of the people in the meeting (and nobody else), what it
// suggests is kept only when code accepts it, the recorder reads the suggestions that still apply, and the recorder's own click is the only thing that renames a speaker: the
// draft lines of that one label take the attendee's name, published lines never change, and every refusal is a fixed code.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AiMeter } from '@crove/agent';
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

const NAMES: Record<string, string | null> = {
  owner: null,
  recorder: 'Hoàng Văn Ghi',
  lan: 'Trần Thị Lan',
  nameless: null,
  stranger: 'Người Ngoài Cuộc',
};

suite('speaker names suggested by the recorder\'s Vy (#3502)', () => {
  const dbName = `crove_test_speaker_suggest_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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

  // What the model was asked, and what it answers (set by each test).
  const prompts: Array<{ system: string; user: string }> = [];
  let modelAnswer = '';
  const model: ModelPort = {
    generate: async (_who, prompt) => {
      prompts.push(prompt);
      return { text: modelAnswer, usage: { inputTokens: 100, outputTokens: 30 } };
    },
  };
  const meter: AiMeter = { admit: async () => undefined, record: async () => undefined };
  const deps = (): MeetingSummaryDeps => ({ runtime, model, meter: () => meter, budget: new DraftBudget({ perUserPerMinute: 100, perOrgPerMinute: 100 }), timeoutMs: 2000 });
  afterEach(() => {
    prompts.length = 0;
    setSummaryEnabled(true);
  });

  const answer = (speakers: unknown) => JSON.stringify({ summary: 'Hai người bàn về báo giá.', decisions: ['Giữ giá cũ'], items: [], speakers });

  // A meeting recorded by the recorder, with Lan (and others given) as attendees, and a draft transcript of two speakers (label 1 on lines 0-10 and 20-30, label 2 on 10-20).
  async function seedMeeting(attendees: string[] = ['lan']): Promise<string> {
    const meetingId = randomUUID();
    await sqlAdmin(
      `INSERT INTO crove_meetings.meeting (org_id, id, title, language, started_at, ended_at, length_seconds, recorder_user_id, visibility, status, consent_method, consent_confirmed_by, consent_confirmed_at, consent_notice_version, audio_retention_date, text_retention_date)
       VALUES ($1, $2, 'Họp báo giá', 'vi', '2026-11-10T03:00:00Z', '2026-11-10T03:30:00Z', 1800, $3, 'attendees', 'ready', 'told_at_start', $3, now(), '1.0', current_date + 30, current_date + 365)`,
      [orgId, meetingId, users.recorder],
    );
    for (const who of attendees) await sqlAdmin('INSERT INTO crove_meetings.meeting_reader (org_id, id, meeting_id, user_id) VALUES ($1, $2, $3, $4)', [orgId, randomUUID(), meetingId, users[who]]);
    await exec('recorder', 'meetings.transcript.draft_store', {
      meetingId,
      segments: [
        { startSeconds: 0, endSeconds: 10, speakerLabel: 'Người nói 1', text: 'Chào chị Lan, em là Ghi bên kinh doanh.' },
        { startSeconds: 10, endSeconds: 20, speakerLabel: 'Người nói 2', text: 'Chào anh Ghi, chị Lan đây. Hôm nay họp về báo giá.' },
        { startSeconds: 20, endSeconds: 30, speakerLabel: 'Người nói 1', text: 'Em sẽ gửi báo giá trước thứ sáu.' },
      ],
    });
    return meetingId;
  }
  const labels = async (meetingId: string) =>
    (await sqlAdmin<{ speaker_label: string; stage: string; corrected: boolean; start_seconds: string }>(
      'SELECT speaker_label, stage, corrected, start_seconds::text FROM crove_meetings.transcript_segment WHERE meeting_id = $1 ORDER BY start_seconds, id',
      [meetingId],
    )).rows.map((r) => `${r.start_seconds}|${r.stage}|${r.speaker_label}|${r.corrected ? 'corrected' : 'as stored'}`);
  const summarize = async (meetingId: string, speakers: unknown) => {
    modelAnswer = answer(speakers);
    const out = await runMeetingSummary(deps(), orgId, asUser('recorder'), meetingId);
    expect(out).toMatchObject({ state: 'ready' });
    return out.runId;
  };
  const suggestions = (who: string, meetingId: string, runId: string) => query<{ suggestions: Array<{ label: string; name: string; seconds: number }> }>(who, 'meetings.speaker.suggestions', { meetingId, runId });
  const name = (who: string, meetingId: string, label: string, to: string) => exec<{ lines: number }>(who, 'meetings.speaker.name', { meetingId, label, name: to });

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
    for (const [key, display] of Object.entries(NAMES)) users[key] = await upsertIdentity(createDb(pool), { issuer: 'speaker-suggest', subject: key, email: `${key}@speaker-suggest.test`, name: display });
    orgId = (await createOrg(runtime, asUser('owner'), 'Người nói')).orgId;
    await sqlAdmin(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member'), ($1, $4, 'member'), ($1, $5, 'member')`, [orgId, users.recorder, users.lan, users.nameless, users.stranger]);
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

  it('tells the model the names of the recorder and the attendees only, as data, and never an email address or a member who is not in the meeting', async () => {
    const meetingId = await seedMeeting(['lan', 'nameless']);
    await summarize(meetingId, []);
    expect(prompts).toHaveLength(1);
    const sent = prompts[0]!;
    expect(sent.user).toMatch(/ATTENDEES:\n- Hoàng Văn Ghi\n- Trần Thị Lan\n\nTRANSCRIPT:\n\[0:00\] Người nói 1:/);
    expect(sent.system).toContain('never use a name that is not in ATTENDEES');
    for (const never of ['Người Ngoài', 'nameless', '@speaker-suggest.test']) expect(sent.user).not.toContain(never);
  });

  it('suggests, the recorder reads what still applies and accepts one: the draft lines of that label take the name, nothing else changes', async () => {
    const meetingId = await seedMeeting(['lan']);
    const runId = await summarize(meetingId, [
      { label: 'Người nói 2', name: 'trần thị lan', seconds: 15 },
      { label: 'Người nói 1', name: 'Hoàng Văn Ghi', seconds: 5 },
      { label: 'Người nói 1', name: 'Người Ngoài Cuộc', seconds: 25 }, // not an attendee: dropped by the checks
    ]);
    // Nothing is renamed by the run itself.
    expect(await labels(meetingId)).toEqual(['0.000|draft|Người nói 1|as stored', '10.000|draft|Người nói 2|as stored', '20.000|draft|Người nói 1|as stored']);
    expect((await suggestions('recorder', meetingId, runId)).suggestions).toEqual([
      { label: 'Người nói 2', name: 'Trần Thị Lan', seconds: 15 },
      { label: 'Người nói 1', name: 'Hoàng Văn Ghi', seconds: 5 },
    ]);
    expect(await name('recorder', meetingId, 'Người nói 2', 'Trần Thị Lan')).toMatchObject({ lines: 1 });
    expect(await labels(meetingId)).toEqual(['0.000|draft|Người nói 1|as stored', '10.000|draft|Trần Thị Lan|corrected', '20.000|draft|Người nói 1|as stored']);
    // The label is gone now: the suggestion no longer applies, and a second click is refused (the run's result still holds it, but no draft line has the label).
    expect((await suggestions('recorder', meetingId, runId)).suggestions).toEqual([{ label: 'Người nói 1', name: 'Hoàng Văn Ghi', seconds: 5 }]);
    expect(await refuses(name('recorder', meetingId, 'Người nói 2', 'Trần Thị Lan'))).toBe('SPEAKER_LABEL_GONE');
    expect(await name('recorder', meetingId, 'Người nói 1', 'Hoàng Văn Ghi')).toMatchObject({ lines: 2 });
    expect(await labels(meetingId)).toEqual(['0.000|draft|Hoàng Văn Ghi|corrected', '10.000|draft|Trần Thị Lan|corrected', '20.000|draft|Hoàng Văn Ghi|corrected']);
    // The audit names the meeting, the run and a count, never a name.
    const audit = await sqlAdmin<{ detail: unknown }>(`SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'meetings.speaker.name' AND target_id = $2`, [orgId, meetingId]);
    // Two accepted clicks and the refused one in between.
    expect(audit.rows).toHaveLength(3);
    expect(JSON.stringify(audit.rows)).not.toMatch(/Lan|Ghi|Người nói/);
  });

  it('refuses anyone but the recorder, a name that is not one of the meeting\'s people or that left it, and a label no draft line has any more', async () => {
    const meetingId = await seedMeeting(['lan']);
    const runId = await summarize(meetingId, [{ label: 'Người nói 2', name: 'Trần Thị Lan', seconds: 15 }]);
    // Not the recorder: an attendee who reads the meeting is told so; a member who is not in the meeting and the owner meet the answer for a meeting that is not there.
    expect(await refuses(suggestions('lan', meetingId, runId))).toBe('FORBIDDEN');
    expect(await refuses(name('lan', meetingId, 'Người nói 2', 'Trần Thị Lan'))).toBe('FORBIDDEN');
    for (const who of ['stranger', 'owner']) {
      expect(await refuses(suggestions(who, meetingId, runId)), `${who} reads`).toMatch(/FORBIDDEN|MEETING_NOT_FOUND/);
      expect(await refuses(name(who, meetingId, 'Người nói 2', 'Trần Thị Lan')), `${who} names`).toMatch(/FORBIDDEN|MEETING_NOT_FOUND/);
    }
    // A name that is not one of the people in the meeting, even a member of the org, and a label no draft line has.
    expect(await refuses(name('recorder', meetingId, 'Người nói 2', 'Người Ngoài Cuộc'))).toBe('SPEAKER_NOT_ATTENDEE');
    expect(await refuses(name('recorder', meetingId, 'Người nói 9', 'Trần Thị Lan'))).toBe('SPEAKER_LABEL_GONE');
    // Lan leaves the meeting: the suggestion is not listed, and the click is refused.
    await sqlAdmin('DELETE FROM crove_meetings.meeting_reader WHERE meeting_id = $1 AND user_id = $2', [meetingId, users.lan]);
    expect((await suggestions('recorder', meetingId, runId)).suggestions).toEqual([]);
    expect(await refuses(name('recorder', meetingId, 'Người nói 2', 'Trần Thị Lan'))).toBe('SPEAKER_NOT_ATTENDEE');
    expect(await labels(meetingId)).toEqual(['0.000|draft|Người nói 1|as stored', '10.000|draft|Người nói 2|as stored', '20.000|draft|Người nói 1|as stored']);
    // A run of another feature or meeting is not a source of suggestions.
    const other = await seedMeeting(['lan']);
    expect(await refuses(suggestions('recorder', other, runId))).toBe('SUMMARY_RESULT_NOT_FOUND');
  });

  it('does not merge two speakers: a name another speaker already has is not suggested, and the click is refused', async () => {
    const meetingId = await seedMeeting(['lan']);
    // Label 1 was named Lan earlier; label 2 is still unnamed.
    await sqlAdmin(`UPDATE crove_meetings.transcript_segment SET speaker_label = 'Trần Thị Lan' WHERE meeting_id = $1 AND start_seconds = 0`, [meetingId]);
    const runId = await summarize(meetingId, [{ label: 'Người nói 2', name: 'Trần Thị Lan', seconds: 15 }]);
    expect((await suggestions('recorder', meetingId, runId)).suggestions).toEqual([]);
    expect(await refuses(name('recorder', meetingId, 'Người nói 2', 'Trần Thị Lan'))).toBe('SPEAKER_NAME_TAKEN');
    expect(await refuses(name('recorder', meetingId, 'Người nói 2', 'Người nói 2'))).toBe('SPEAKER_NOT_ATTENDEE');
    expect(await labels(meetingId)).toEqual(['0.000|draft|Trần Thị Lan|as stored', '10.000|draft|Người nói 2|as stored', '20.000|draft|Người nói 1|as stored']);
  });

  it('never renames a published line: only the draft lines of the label change', async () => {
    const meetingId = await seedMeeting(['lan']);
    await summarize(meetingId, [{ label: 'Người nói 2', name: 'Trần Thị Lan', seconds: 15 }]);
    await sqlAdmin(`INSERT INTO crove_meetings.transcript_segment (org_id, id, meeting_id, start_seconds, end_seconds, speaker_label, text, stage) VALUES ($1, $2, $3, 40, 50, 'Người nói 2', 'Dòng đã chia sẻ', 'published')`, [orgId, randomUUID(), meetingId]);
    expect(await name('recorder', meetingId, 'Người nói 2', 'Trần Thị Lan')).toMatchObject({ lines: 1 });
    expect(await labels(meetingId)).toEqual(['0.000|draft|Người nói 1|as stored', '10.000|draft|Trần Thị Lan|corrected', '20.000|draft|Người nói 1|as stored', '40.000|published|Người nói 2|as stored']);
  });

  it('asks nothing of the model about speakers and changes nothing when nobody is offered, and with AI off the run is refused as ever', async () => {
    // The notes run (A5) is not told the attendees at all.
    const meetingId = await seedMeeting(['lan']);
    await exec('recorder', 'meetings.notes.save', { meetingId, body: 'Chốt giữ giá cũ\nGhi gửi báo giá' });
    modelAnswer = JSON.stringify({ sections: [{ key: 'all', lines: [{ note: 1 }, { text: 'Ghi sẽ gửi báo giá.', seconds: 25 }] }] });
    const notes = await runNotesEnhance(deps(), orgId, asUser('recorder'), meetingId);
    expect(notes).toMatchObject({ state: 'ready' });
    expect(prompts[0]!.user).not.toContain('ATTENDEES');
    expect(prompts[0]!.system).not.toContain('speakers');
    expect((await suggestions('recorder', meetingId, notes.runId)).suggestions).toEqual([]);
    // A model that suggests nothing leaves the transcript as it was.
    const runId = await summarize(meetingId, []);
    expect((await suggestions('recorder', meetingId, runId)).suggestions).toEqual([]);
    expect(await labels(meetingId)).toEqual(['0.000|draft|Người nói 1|as stored', '10.000|draft|Người nói 2|as stored', '20.000|draft|Người nói 1|as stored']);
    // With the deployment's switch off no run starts, so nothing is suggested.
    setSummaryEnabled(false);
    expect(await refuses(runMeetingSummary(deps(), orgId, asUser('recorder'), meetingId))).toBe('SUMMARY_OFF');
  });
});

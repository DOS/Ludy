// SPDX-License-Identifier: AGPL-3.0-only
// "Gợi ý tên" on a real database (#3947): the run starts for the recorder alone, with the switch on, a transcript and no transcription running; it keeps no suggestion (the result row holds counts only);
// the rename is the recorder's own command, the title is cleaned and bounded, the audit row names the meeting and never the title, and nothing renames a meeting but that command.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import { Runtime } from '@ludy/kernel-runtime';
import { meetingsCommands, meetingsQueries, setSummaryEnabled } from '@ludy/mod-meetings';
import { TEST_MANIFESTS } from './invariant/fixtures/manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('the recorder\'s Vy title suggestion (#3947)', () => {
  const dbName = `crove_test_title_suggest_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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
    for (const key of ['owner', 'recorder', 'reader', 'stranger']) users[key] = await upsertIdentity(createDb(pool), { issuer: 'title', subject: key, email: `${key}@title.test`, name: null });
    orgId = (await createOrg(runtime, asUser('owner'), 'Gợi ý tên')).orgId;
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
  const titleRun = (who: string, meetingId: string) => exec<{ meetingId: string; runId: string }>(who, 'meetings.title.start', { meetingId });
  const titleOf = (meetingId: string) => sqlAdmin<{ title: string }>(`SELECT title FROM ludy_meetings.meeting WHERE org_id = $1 AND id = $2`, [orgId, meetingId]).then((r) => r.rows[0]?.title);

  it('starts a run for the recorder alone, with the switch on and a transcript to read', async () => {
    const meetingId = await seedMeeting('recorder');
    expect(await query('recorder', 'meetings.title.status', { meetingId })).toEqual({ meetingId, enabled: true, reason: null });
    expect(await query('reader', 'meetings.title.status', { meetingId })).toEqual({ meetingId, enabled: false, reason: 'not_recorder' });
    expect(await refuses(titleRun('reader', meetingId))).toBe('FORBIDDEN');
    expect(await refuses(titleRun('stranger', meetingId))).not.toBeNull();
    const started = await titleRun('recorder', meetingId);
    const run = await sqlAdmin<{ feature: string; subject_type: string; subject_id: string }>(`SELECT feature, subject_type, subject_id FROM ludy_kernel.member_vy_result WHERE org_id = $1 AND run_id = $2`, [orgId, started.runId]);
    expect(run.rows[0]).toMatchObject({ feature: 'meetings.title', subject_type: 'meeting', subject_id: meetingId });
    // The run changed nothing about the meeting.
    expect(await titleOf(meetingId)).toBe('Họp tuần');
    // A meeting with no transcript has nothing to name it from.
    const empty = await seedMeeting('recorder');
    await sqlAdmin(`DELETE FROM ludy_meetings.transcript_segment WHERE org_id = $1 AND meeting_id = $2`, [orgId, empty]);
    expect(await refuses(titleRun('recorder', empty))).toBe('TRANSCRIPT_EMPTY');
    setSummaryEnabled(false);
    try {
      expect(await query('recorder', 'meetings.title.status', { meetingId })).toMatchObject({ enabled: false, reason: 'off' });
      expect(await refuses(titleRun('recorder', meetingId))).toBe('SUMMARY_OFF');
    } finally {
      setSummaryEnabled(true);
    }
  });

  it('does not start while the meeting is still being transcribed', async () => {
    const meetingId = await seedMeeting('recorder');
    await exec('recorder', 'kernel.member_vy.run.start', { feature: 'meetings.transcribe', subjectType: 'meeting', subjectId: meetingId });
    expect(await refuses(titleRun('recorder', meetingId))).toBe('TRANSCRIBE_RUNNING');
  });

  it('renames for the recorder alone, cleans the title, and audits the meeting without the title', async () => {
    const meetingId = await seedMeeting('recorder');
    expect(await refuses(exec('reader', 'meetings.meeting.rename', { meetingId, title: 'Không được' }))).toBe('FORBIDDEN');
    expect(await refuses(exec('stranger', 'meetings.meeting.rename', { meetingId, title: 'Không được' }))).not.toBeNull();
    expect(await titleOf(meetingId)).toBe('Họp tuần');
    // Control, bidi and zero-width characters go, line breaks become spaces, spaces fold.
    const renamed = await exec<{ meetingId: string; title: string }>('recorder', 'meetings.meeting.rename', { meetingId, title: '  Chốt\u202E báo\u200B giá\n tháng  12 ' });
    expect(renamed).toEqual({ meetingId, title: 'Chốt báo giá tháng 12' });
    expect(await titleOf(meetingId)).toBe('Chốt báo giá tháng 12');
    expect(await refuses(exec('recorder', 'meetings.meeting.rename', { meetingId, title: '\u200B \u202E' }))).toBe('MEETING_TITLE_EMPTY');
    expect(await refuses(exec('recorder', 'meetings.meeting.rename', { meetingId, title: 'a'.repeat(201) }))).not.toBeNull();
    expect(await titleOf(meetingId)).toBe('Chốt báo giá tháng 12');
    const audit = await sqlAdmin<{ detail: unknown }>(`SELECT detail FROM ludy_kernel.audit_event WHERE org_id = $1 AND command = 'meetings.meeting.rename' AND outcome = 'ok' ORDER BY id DESC LIMIT 1`, [orgId]);
    // Refused attempts are audited too (with their code); the successful rename's row is the one that names the meeting.
    const detail = JSON.stringify(audit.rows[0]?.detail);
    expect(detail).toContain(meetingId);
    expect(detail).not.toContain('Chốt');
    expect(detail).not.toContain('Họp tuần');
  });

  it('keeps the suggestion nowhere: a stored result holds counts only', async () => {
    const meetingId = await seedMeeting('recorder');
    const { runId } = await titleRun('recorder', meetingId);
    await exec('recorder', 'kernel.member_vy.result.store', { runId, outcome: { status: 'ready', body: JSON.stringify({ v: 1, titles: 2, dropped: 1 }) } });
    const stored = await sqlAdmin<{ body: string | null }>(`SELECT body FROM ludy_kernel.member_vy_result WHERE org_id = $1 AND run_id = $2`, [orgId, runId]);
    // Three numbers: no title, no word of the meeting.
    expect(JSON.parse(stored.rows[0]?.body ?? 'null')).toEqual({ v: 1, titles: 2, dropped: 1 });
  });
});

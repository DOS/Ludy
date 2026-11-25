// SPDX-License-Identifier: AGPL-3.0-only
// Vy's label suggestions on a real database (#5010): the run starts for the recorder alone, with the deployment's switch on and room for a label (a meeting with five labels is refused, LABELS_FULL, and no run is made);
// no transcript is needed; the audit row of the start holds ids only; a stored result holds counts only; and nothing about a suggestion is stored: the run adds no label, only the recorder's own label add does.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import { MEETING_LABELS_MAX } from '@ludy/kernel-contract';
import { Runtime } from '@ludy/kernel-runtime';
import { meetingsCommands, meetingsQueries, setSummaryEnabled } from '@ludy/mod-meetings';
import { TEST_MANIFESTS } from './invariant/fixtures/manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

const TITLE = 'Họp báo giá Hoa Sen';

suite('the recorder\'s Vy label suggestion (#5010)', () => {
  const dbName = `ludy_test_label_suggest_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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
  // A meeting with no transcript at all: the suggestion does not read one.
  async function seedMeeting(recorder: string, readers: string[] = ['reader']): Promise<string> {
    const meetingId = randomUUID();
    await sqlAdmin(
      `INSERT INTO ludy_meetings.meeting (org_id, id, title, language, started_at, ended_at, length_seconds, recorder_user_id, visibility, status, consent_method, consent_confirmed_by, consent_confirmed_at, consent_notice_version, audio_retention_date, text_retention_date)
       VALUES ($1, $2, $4, 'vi', '2026-11-10T03:00:00Z', '2026-11-10T04:00:00Z', 3600, $3, 'attendees', 'ready', 'told_at_start', $3, now(), '1.0', current_date + 30, current_date + 365)`,
      [orgId, meetingId, users[recorder], TITLE],
    );
    for (const reader of readers) await sqlAdmin(`INSERT INTO ludy_meetings.meeting_reader (org_id, id, meeting_id, user_id) VALUES ($1, $2, $3, $4)`, [orgId, randomUUID(), meetingId, users[reader]]);
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
    const pool = createPool({ connectionString: url.toString(), max: 4 });
    pools.push(pool);
    runtime = new Runtime(createDb(pool), { manifests: TEST_MANIFESTS }).register({
      commands: [...kernelCommands, ...meetingsCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...meetingsQueries],
    });
    setSummaryEnabled(true);
    for (const key of ['owner', 'recorder', 'reader', 'stranger']) users[key] = await upsertIdentity(createDb(pool), { issuer: 'label-suggest', subject: key, email: `${key}@label-suggest.test`, name: null });
    orgId = (await createOrg(runtime, asUser('owner'), 'Gợi ý nhãn')).orgId;
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

  const start = (who: string, meetingId: string) => exec<{ meetingId: string; runId: string }>(who, 'meetings.label.suggest_start', { meetingId });
  const labelsOf = async (meetingId: string) => (await sqlAdmin<{ label: string }>(`SELECT label FROM ludy_meetings.meeting_label WHERE org_id = $1 AND meeting_id = $2 ORDER BY label`, [orgId, meetingId])).rows.map((r) => r.label);
  const runsOf = async (meetingId: string) => (await sqlAdmin<{ feature: string; subject_type: string; subject_id: string }>(`SELECT feature, subject_type, subject_id FROM ludy_kernel.member_vy_result WHERE org_id = $1 AND subject_id = $2`, [orgId, meetingId])).rows;

  it('starts a run for the recorder alone, with the switch on, and needs no transcript', async () => {
    const meetingId = await seedMeeting('recorder');
    expect(await query('recorder', 'meetings.label.suggest_status', { meetingId })).toEqual({ meetingId, enabled: true, reason: null });
    // A reader of the meeting may read it but not ask Vy for its labels; a member who cannot read it finds no meeting.
    expect(await query('reader', 'meetings.label.suggest_status', { meetingId })).toEqual({ meetingId, enabled: false, reason: 'not_recorder' });
    expect(await refuses(start('reader', meetingId))).toBe('FORBIDDEN');
    expect(await refuses(start('stranger', meetingId))).toBe('MEETING_NOT_FOUND');
    expect(await runsOf(meetingId)).toEqual([]);
    const started = await start('recorder', meetingId);
    expect(await runsOf(meetingId)).toEqual([{ feature: 'meetings.label_suggest', subject_type: 'meeting', subject_id: meetingId }]);
    expect(started.meetingId).toBe(meetingId);
  });

  it('is off with the deployment\'s switch off: SUMMARY_OFF and no run', async () => {
    const meetingId = await seedMeeting('recorder');
    setSummaryEnabled(false);
    try {
      expect(await query('recorder', 'meetings.label.suggest_status', { meetingId })).toMatchObject({ enabled: false, reason: 'off' });
      expect(await refuses(start('recorder', meetingId))).toBe('SUMMARY_OFF');
    } finally {
      setSummaryEnabled(true);
    }
    expect(await runsOf(meetingId)).toEqual([]);
  });

  it('refuses a meeting that has five labels already, LABELS_FULL, and makes no run; four labels still start', async () => {
    const meetingId = await seedMeeting('recorder');
    for (let i = 1; i < MEETING_LABELS_MAX; i++) await exec('recorder', 'meetings.label.add', { meetingId, label: `Nhãn ${i}` });
    expect(await runsOf(meetingId)).toEqual([]);
    await start('recorder', meetingId);
    const other = await seedMeeting('recorder');
    for (let i = 1; i <= MEETING_LABELS_MAX; i++) await exec('recorder', 'meetings.label.add', { meetingId: other, label: `Nhãn ${i}` });
    expect(await refuses(start('recorder', other))).toBe('LABELS_FULL');
    expect(await runsOf(other)).toEqual([]);
  });

  it('audits the start by ids only: no title and no label text in the row', async () => {
    const meetingId = await seedMeeting('recorder');
    await exec('recorder', 'meetings.label.add', { meetingId, label: 'Khách Hoa Sen Bí Mật' });
    const { runId } = await start('recorder', meetingId);
    const audit = await sqlAdmin<{ detail: unknown }>(`SELECT detail FROM ludy_kernel.audit_event WHERE org_id = $1 AND command = 'meetings.label.suggest_start' AND outcome = 'ok' AND target_id = $2`, [orgId, meetingId]);
    expect(audit.rows).toHaveLength(1);
    const detail = JSON.stringify(audit.rows[0]?.detail);
    expect(detail).toContain(meetingId);
    expect(detail).toContain(runId);
    expect(detail).not.toContain(TITLE);
    expect(detail).not.toContain('Hoa Sen');
    expect(detail).not.toContain('Bí Mật');
  });

  it('keeps the suggestion nowhere: a stored result holds counts only, and the run adds no label', async () => {
    const meetingId = await seedMeeting('recorder');
    await exec('recorder', 'meetings.label.add', { meetingId, label: 'Có sẵn' });
    const before = await labelsOf(meetingId);
    const { runId } = await start('recorder', meetingId);
    await exec('recorder', 'kernel.member_vy.result.store', { runId, outcome: { status: 'ready', body: JSON.stringify({ v: 1, labels: 2, dropped: 1 }) } });
    const stored = await sqlAdmin<{ body: string | null }>(`SELECT body FROM ludy_kernel.member_vy_result WHERE org_id = $1 AND run_id = $2`, [orgId, runId]);
    // Three numbers: no label, no word of the meeting.
    expect(JSON.parse(stored.rows[0]?.body ?? 'null')).toEqual({ v: 1, labels: 2, dropped: 1 });
    expect(await labelsOf(meetingId)).toEqual(before);
  });
});

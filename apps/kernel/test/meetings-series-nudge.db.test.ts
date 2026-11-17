// SPDX-License-Identifier: AGPL-3.0-only
// The nudge of a meeting series (#3542, part 2) on a real database: about 30 minutes before the next meeting of a series, a person with open items from the previous meeting gets one in-app notice
// (a count and a link, never a title), once; and nobody else does: not a person who is not invited (no such event in their own calendar), who did not read the previous meeting, whose item is done,
// not accepted or now with someone else, nor one who turned the kind off or left.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { GOOGLE_CALENDAR_EVENTS_READ_SCOPE } from '@crove/kernel-contract';
import { Runtime } from '@crove/kernel-runtime';
import { meetingsCommands, meetingsQueries } from '@crove/mod-meetings';
import { TEST_MANIFESTS } from './invariant/fixtures/manifests.ts';
import { runMeetingsSeriesNudgeSweep } from '../src/meetings-series-nudge.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const SYSTEM = { type: 'system' as const, component: 'test.series-nudge' };
const KIND = 'meetings.series_open_items';
const suite = ADMIN ? describe : describe.skip;

suite('the series nudge (#3542)', () => {
  const dbName = `crove_test_nudge_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  const pools: pg.Pool[] = [];
  let workerDb: ReturnType<typeof createDb>;
  let orgId = '';
  let worker: Runtime;
  let appRuntime: Runtime;
  const users: Record<string, string> = {};
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
  const iso = (offsetMinutes: number) => new Date(Date.now() + offsetMinutes * 60_000).toISOString();
  const sweep = () => runMeetingsSeriesNudgeSweep({ runtime: worker, workerDb });

  // A member's calendar connection and an event of theirs, starting `startMinutes` from now, in `series` (a series id as the sweep keeps it).
  async function connection(who: string): Promise<string> {
    const id = randomUUID();
    await sqlAdmin(`INSERT INTO crove_kernel.calendar_connection (org_id, id, user_id, provider, external_account, display_name, scopes, read_events) VALUES ($1, $2, $3, 'google', $4, $4, $5, true)`, [
      orgId,
      id,
      users[who],
      `${who}-${randomUUID().slice(0, 6)}@calendar.test`,
      [GOOGLE_CALENDAR_EVENTS_READ_SCOPE],
    ]);
    return id;
  }
  async function calendarEvent(who: string, startMinutes: number, series: string | null): Promise<void> {
    await sqlAdmin(
      `INSERT INTO crove_meetings.calendar_agenda (org_id, connection_id, user_id, external_id, title, starts_at, ends_at, time_zone, series_id)
       VALUES ($1, $2, $3, $4, 'Họp giao ban', $5, $6, 'Asia/Ho_Chi_Minh', $7)`,
      [orgId, await connection(who), users[who], randomUUID(), iso(startMinutes), iso(startMinutes + 60), series],
    );
  }
  // A meeting recorded by `rec`, started `startMinutes` from now, read by `readers`, in `series`.
  async function meeting(startMinutes: number, readers: string[], series: string | null, title = 'Giao ban tuần trước'): Promise<string> {
    const id = randomUUID();
    await sqlAdmin(
      `INSERT INTO crove_meetings.meeting (org_id, id, title, language, started_at, ended_at, length_seconds, recorder_user_id, visibility, status, consent_method, consent_confirmed_by, consent_confirmed_at, consent_notice_version, audio_retention_date, text_retention_date, series_id)
       VALUES ($1, $2, $6, 'vi', $4, $5, 3600, $3, 'attendees', 'ready', 'told_at_start', $3, now(), '1.0', current_date + 20, current_date + 365, $7)`,
      [orgId, id, users.rec, iso(startMinutes), iso(startMinutes + 60), title, series],
    );
    for (const who of readers) await sqlAdmin('INSERT INTO crove_meetings.meeting_reader (org_id, id, meeting_id, user_id) VALUES ($1, $2, $3, $4)', [orgId, randomUUID(), id, users[who]]);
    return id;
  }
  async function seat(title: string, holder: string): Promise<string> {
    const id = randomUUID();
    await sqlAdmin(`INSERT INTO crove_kernel.position (org_id, id, title, module, role_key, holder_user_id) VALUES ($1, $2, $3, 'kernel', 'member', $4)`, [orgId, id, title, users[holder]]);
    return id;
  }
  // An item of a meeting, published, parsed to `parsed`, accepted when `task` (a status) is given, with the task in `seat`.
  async function item(meetingId: string, title: string, over: { task?: string; parsed?: string; seat?: string; stage?: 'draft' | 'published' } = {}): Promise<void> {
    const id = randomUUID();
    let taskId: string | null = null;
    if (over.task !== undefined) {
      taskId = randomUUID();
      await sqlAdmin(`INSERT INTO crove_kernel.task (org_id, id, title, source, created_by_type, status, assignee_position_id) VALUES ($1, $2, $3, 'human', 'system', $4, $5)`, [orgId, taskId, title, over.task, over.seat ?? null]);
    }
    await sqlAdmin(
      `INSERT INTO crove_meetings.action_item (org_id, id, meeting_id, title, who_drafted, who_parsed, when_drafted, stage, status, task_id, tainted, transcript_seconds)
       VALUES ($1, $2, $3, $4, 'Lan', $5, 'thứ sáu', $6, $7, $8, false, 10)`,
      [orgId, id, meetingId, title, users[over.parsed ?? 'lan'], over.stage ?? 'published', taskId === null ? 'suggested' : 'accepted', taskId],
    );
  }
  const notices = async (who?: string) =>
    (
      await sqlAdmin<{ user_id: string; subject_id: string | null; detail: Record<string, string>; dedupe_key: string }>(
        `SELECT user_id, subject_id, detail, dedupe_key FROM crove_kernel.notification WHERE org_id = $1 AND kind = $2 ${who ? 'AND user_id = $3' : ''} ORDER BY created_at`,
        who ? [orgId, KIND, users[who]] : [orgId, KIND],
      )
    ).rows;

  beforeAll(async () => {
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });
    const login = (user: string, password: string) => {
      const url = new URL(adminUrl);
      url.username = user;
      url.password = password;
      return url.toString();
    };
    const appPool = createPool({ connectionString: login('crove_app', 'test-app-pw'), max: 4 });
    const workerPool = createPool({ connectionString: login('crove_worker', 'test-worker-pw'), max: 4 });
    pools.push(appPool, workerPool);
    workerDb = createDb(workerPool);
    const registry = { commands: [...kernelCommands, ...meetingsCommands], queries: [...kernelQueries({ inboundDomain: null }), ...meetingsQueries] };
    worker = new Runtime(workerDb, { manifests: TEST_MANIFESTS }).register(registry);
    appRuntime = new Runtime(createDb(appPool), { manifests: TEST_MANIFESTS }).register(registry);
    for (const key of ['owner', 'rec', 'lan', 'nam', 'other']) users[key] = await upsertIdentity(createDb(appPool), { issuer: 'nudge', subject: key, email: `${key}@nudge.test`, name: key });
    orgId = (await createOrg(appRuntime, { type: 'user', userId: users.owner as string, aal: 'aal1' }, 'Công ty Nhắc việc')).orgId;
    await sqlAdmin(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member'), ($1, $4, 'member'), ($1, $5, 'member')`, [orgId, users.rec, users.lan, users.nam, users.other]);
  }, 300_000);

  beforeEach(async () => {
    await sqlAdmin('DELETE FROM crove_kernel.calendar_connection WHERE org_id = $1', [orgId]);
    await sqlAdmin('DELETE FROM crove_meetings.meeting WHERE org_id = $1', [orgId]);
    await sqlAdmin('DELETE FROM crove_kernel.task WHERE org_id = $1', [orgId]);
    await sqlAdmin(`DELETE FROM crove_kernel.position WHERE org_id = $1 AND title LIKE 'Ghế thử%'`, [orgId]);
    await sqlAdmin('DELETE FROM crove_kernel.notification WHERE org_id = $1', [orgId]);
    await sqlAdmin('DELETE FROM crove_kernel.notification_mute WHERE org_id = $1', [orgId]);
  });

  afterAll(async () => {
    for (const pool of pools) await pool.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('tells a person with open items, once, how many and where, with no title: only their own items count', async () => {
    const series = randomUUID();
    const earlier = await meeting(-300, ['lan', 'nam'], series, 'Họp riêng về hợp đồng Alpha');
    await item(earlier, 'Gửi báo giá Alpha', { task: 'todo' });
    await item(earlier, 'Gọi lại khách Beta', { task: 'in_progress' });
    await item(earlier, 'Việc của Nam', { task: 'todo', parsed: 'nam' });
    await calendarEvent('lan', 20, series);
    const first = await sweep();
    expect(first).toEqual({ found: 1, sent: 1, failures: 0 });
    const got = await notices('lan');
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ subject_id: earlier, detail: { count: '2' } });
    // A count and ids only: no title of the meeting or of an item.
    expect(JSON.stringify(got[0])).not.toMatch(/Alpha|Beta|hợp đồng|báo giá/);
    // The same pass again, and a replayed command, write nothing more.
    expect(await sweep()).toMatchObject({ sent: 0 });
    expect(await notices('lan')).toHaveLength(1);
    // Nam has items but no such event in their own calendar, so is not told.
    expect(await notices('nam')).toHaveLength(0);
  });

  it('does not nudge outside the 30 minutes, for an event that began, or for one that is in no series', async () => {
    const series = randomUUID();
    const earlier = await meeting(-300, ['lan'], series);
    await item(earlier, 'Việc mở', { task: 'todo' });
    await calendarEvent('lan', 45, series);
    await calendarEvent('lan', -5, series);
    await calendarEvent('lan', 10, null);
    expect(await sweep()).toMatchObject({ found: 0, sent: 0 });
    expect(await notices()).toHaveLength(0);
  });

  it('does not nudge for items that are done, cancelled, not accepted, drafts, or of a meeting the person did not read', async () => {
    const series = randomUUID();
    const read = await meeting(-300, ['lan'], series);
    await item(read, 'Đã xong', { task: 'done' });
    await item(read, 'Đã hủy', { task: 'cancelled' });
    await item(read, 'Chưa ai nhận');
    await item(read, 'Việc nháp', { task: 'todo', stage: 'draft' });
    await calendarEvent('lan', 15, series);
    // Nam's item sits in the later meeting of the series, which Nam did not read: the earlier one they read has none of theirs.
    const unread = await meeting(-100, ['lan'], series);
    await item(unread, 'Việc của Nam', { task: 'todo', parsed: 'nam' });
    await calendarEvent('nam', 15, series);
    expect(await sweep()).toMatchObject({ found: 0, sent: 0 });
    expect(await notices()).toHaveLength(0);
  });

  it('follows the task to the person it is with now: the one it was parsed to is not told after a hand-over, the new holder is', async () => {
    const series = randomUUID();
    const earlier = await meeting(-300, ['lan', 'nam'], series);
    await item(earlier, 'Việc đã giao lại', { task: 'todo', parsed: 'lan', seat: await seat('Ghế thử A', 'nam') });
    await calendarEvent('lan', 15, series);
    await calendarEvent('nam', 15, series);
    expect(await sweep()).toMatchObject({ found: 1, sent: 1 });
    expect(await notices('lan')).toHaveLength(0);
    expect(await notices('nam')).toHaveLength(1);
  });

  it('sends nothing to a person who turned the kind off or left the org', async () => {
    const series = randomUUID();
    const earlier = await meeting(-300, ['lan', 'nam'], series);
    await item(earlier, 'Việc của Lan', { task: 'todo', parsed: 'lan' });
    await item(earlier, 'Việc của Nam', { task: 'todo', parsed: 'nam' });
    await calendarEvent('lan', 15, series);
    await calendarEvent('nam', 15, series);
    await sqlAdmin('INSERT INTO crove_kernel.notification_mute (org_id, user_id, kind) VALUES ($1, $2, $3)', [orgId, users.lan, KIND]);
    await sqlAdmin('DELETE FROM crove_kernel.tenant_member WHERE org_id = $1 AND user_id = $2', [orgId, users.nam]);
    expect(await sweep()).toMatchObject({ sent: 0, failures: 0 });
    expect(await notices()).toHaveLength(0);
    await sqlAdmin(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')`, [orgId, users.nam]);
  });

  it('checks what the job was told again: a stale nudge writes nothing, and only the system context can ask', async () => {
    const series = randomUUID();
    const earlier = await meeting(-300, ['lan'], series);
    await item(earlier, 'Việc sắp xong', { task: 'todo' });
    const startsAt = iso(15);
    await sqlAdmin(
      `INSERT INTO crove_meetings.calendar_agenda (org_id, connection_id, user_id, external_id, title, starts_at, ends_at, time_zone, series_id)
       VALUES ($1, $2, $3, $4, 'Họp', $5, $6, 'Asia/Ho_Chi_Minh', $7)`,
      [orgId, await connection('lan'), users.lan, randomUUID(), startsAt, iso(75), series],
    );
    const args = { userId: users.lan as string, seriesId: series, startsAt };
    // The task is done between the sweep and the command.
    await sqlAdmin(`UPDATE crove_kernel.task SET status = 'done' WHERE org_id = $1`, [orgId]);
    expect(await worker.execute('meetings.series.nudge', args, { actor: SYSTEM, orgId })).toEqual({ sent: 0 });
    // A person cannot run it, nor read what the sweep reads.
    expect(await refuses(appRuntime.execute('meetings.series.nudge', args, { actor: { type: 'user', userId: users.lan as string, aal: 'aal1' }, orgId }))).toMatch(/FORBIDDEN|ACCESS|NOT_ALLOWED/);
    await expect((pools[0] as pg.Pool).query('SELECT * FROM crove_meetings.series_nudges_due(10)')).rejects.toThrow(/permission denied/);
  });
});

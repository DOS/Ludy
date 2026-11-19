// SPDX-License-Identifier: AGPL-3.0-only
// The Today view (#3955) on a real database: the member's own agenda for today (Vietnam time) with the total time and the facts of each event's brief in one read, working with AI off; a recorded event is briefed
// from its meeting and one whose meeting the member no longer reads is simply empty; and an owner, another member and the system context read none of someone else's agenda or facts.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import type { MeetingsTodayFacts } from '@crove/kernel-contract';
import { Runtime } from '@crove/kernel-runtime';
import { meetingsCommands, meetingsQueries } from '@crove/mod-meetings';
import { TEST_MANIFESTS } from './invariant/fixtures/manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const SYSTEM = { type: 'system' as const, component: 'test.today' };
// 09:00 today in Vietnam, as a timestamp: the day of the Today view is the Vietnam day.
const VN_NINE = `(date_trunc('day', now() at time zone 'Asia/Ho_Chi_Minh') at time zone 'Asia/Ho_Chi_Minh' + interval '9 hours')`;

suite('the Today view of the meetings page (#3955)', () => {
  const dbName = `crove_test_today_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  const pools: pg.Pool[] = [];
  let orgId = '';
  let runtime: Runtime;
  let connection = '';
  const ids: Record<string, string> = {};
  const users: Record<string, string> = {};
  const asUser = (who: string) => ({ type: 'user' as const, userId: users[who] as string, aal: 'aal1' as const });
  const today = (who: string) => runtime.query<MeetingsTodayFacts>('meetings.today.facts', {}, { actor: asUser(who), orgId });
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
  async function meeting(title: string, daysAgo: number, recorder: string, readers: string[], series: string | null): Promise<string> {
    const id = randomUUID();
    await sqlAdmin(
      `INSERT INTO crove_meetings.meeting (org_id, id, title, language, started_at, ended_at, length_seconds, recorder_user_id, visibility, status, consent_method, consent_confirmed_by, consent_confirmed_at, consent_notice_version, audio_retention_date, text_retention_date, series_id)
       VALUES ($1, $2, $4, 'vi', now() - ($5 || ' days')::interval, now() - ($5 || ' days')::interval + interval '30 minutes', 1800, $3, 'attendees', 'ready', 'told_at_start', $3, now(), '1.0', current_date - 1, current_date + 365, $6)`,
      [orgId, id, users[recorder], title, String(daysAgo), series],
    );
    for (const who of readers) await sqlAdmin('INSERT INTO crove_meetings.meeting_reader (org_id, id, meeting_id, user_id) VALUES ($1, $2, $3, $4)', [orgId, randomUUID(), id, users[who]]);
    return id;
  }
  // An agenda event of `lan` starting `startExpr` (a SQL expression) and lasting `minutes`.
  async function event(title: string, startExpr: string, minutes: number, over: { series?: string | null; meetingId?: string | null } = {}): Promise<string> {
    return (
      await sqlAdmin<{ id: string }>(
        `INSERT INTO crove_meetings.calendar_agenda (org_id, connection_id, user_id, external_id, title, starts_at, ends_at, time_zone, series_id, meeting_id)
         VALUES ($1, $2, $3, $4, $5, ${startExpr}, ${startExpr} + ($6 || ' minutes')::interval, 'Asia/Ho_Chi_Minh', $7, $8) RETURNING id`,
        [orgId, connection, users.lan, randomUUID(), title, String(minutes), over.series ?? null, over.meetingId ?? null],
      )
    ).rows[0]!.id;
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
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });
    const url = new URL(adminUrl);
    url.username = 'crove_app';
    url.password = 'test-app-pw';
    const appPool = createPool({ connectionString: url.toString(), max: 4 });
    pools.push(appPool);
    const db = createDb(appPool);
    runtime = new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands, ...meetingsCommands], queries: [...kernelQueries({ inboundDomain: null }), ...meetingsQueries] });
    for (const key of ['owner', 'rec', 'lan', 'other']) users[key] = await upsertIdentity(db, { issuer: 'today', subject: key, email: `${key}@today.test`, name: key });
    orgId = (await createOrg(runtime, asUser('owner'), 'Công ty Hôm Nay')).orgId;
    await sqlAdmin(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member'), ($1, $4, 'member')`, [orgId, users.rec, users.lan, users.other]);
    // One series: last week's meeting (decisions and an open item) and this morning's, which lan reads.
    const series = randomUUID();
    ids.series = series;
    ids.earlier = await meeting('Giao ban tuần trước', 7, 'rec', ['lan'], series);
    await sqlAdmin(`INSERT INTO crove_meetings.meeting_result (org_id, meeting_id, summary, decisions, feature, stage) VALUES ($1, $2, 'Tóm tắt', $3::jsonb, 'manual', 'published')`, [orgId, ids.earlier, JSON.stringify(['Chốt giá gói kế toán 15.000.000 đồng'])]);
    await sqlAdmin(
      `INSERT INTO crove_meetings.action_item (org_id, id, meeting_id, title, who_drafted, who_parsed, when_drafted, stage, status, tainted, transcript_seconds)
       VALUES ($1, $2, $3, 'Gửi báo giá bản cuối', 'Lan', $4, 'thứ sáu', 'published', 'suggested', false, 10)`,
      [orgId, randomUUID(), ids.earlier, users.lan],
    );
    ids.current = await meeting('Giao ban hôm nay', 0, 'rec', ['lan'], series);
    ids.hidden = await meeting('Họp riêng của rec', 1, 'rec', [], null);
    connection = randomUUID();
    await sqlAdmin(`INSERT INTO crove_kernel.calendar_connection (org_id, id, user_id, provider, external_account, display_name, scopes, read_events) VALUES ($1, $2, $3, 'google', 'lan@calendar.test', 'lan', '{}', true)`, [orgId, connection, users.lan]);
    ids.e1 = await event('Giao ban', `${VN_NINE}`, 60, { series });
    ids.e2 = await event('Giao ban đã ghi', `${VN_NINE} + interval '4 hours'`, 90, { series, meetingId: ids.current as string });
    ids.e3 = await event('Cà phê với khách', `${VN_NINE} + interval '7 hours'`, 60);
    ids.yesterday = await event('Họp hôm qua', `${VN_NINE} - interval '1 day'`, 60, { series });
  }, 300_000);

  afterAll(async () => {
    await Promise.all(pools.map((p) => p.end()));
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('lists today\'s events in order with the total time and the facts of each brief in one read, and leaves out yesterday', async () => {
    const out = await today('lan');
    expect(out.enabled).toBe(true);
    expect(out.items.map((i) => i.event.id)).toEqual([ids.e1, ids.e2, ids.e3]);
    expect(out.totalMinutes).toBe(60 + 90 + 60);
    const [first, second, third] = out.items;
    // An event of a series before it is recorded: what was decided last time and what is open.
    expect(first?.brief).toMatchObject({ empty: false, previous: { meetingId: ids.earlier }, decisions: ['Chốt giá gói kế toán 15.000.000 đồng'] });
    expect(first?.brief.items.map((i) => i.title)).toEqual(['Gửi báo giá bản cuối']);
    // A recorded event is briefed from its meeting, the same facts the meeting's own page shows.
    expect(second?.event.meetingId).toBe(ids.current);
    expect(second?.brief).toMatchObject({ empty: false, previous: { meetingId: ids.earlier } });
    expect(third?.brief.empty).toBe(true);
    expect(JSON.stringify(out)).not.toContain('Họp hôm qua');
    // The same facts as the brief read one event at a time.
    const alone = await runtime.query('meetings.brief.facts', { meetingId: null, agendaId: ids.e1 }, { actor: asUser('lan'), orgId });
    expect(first?.brief).toEqual(alone);
  });

  it('shows an owner, another member and the system context none of someone else\'s agenda or facts', async () => {
    for (const who of ['owner', 'rec', 'other']) {
      const out = await today(who);
      expect(out, who).toEqual({ enabled: false, totalMinutes: 0, items: [] });
    }
    expect(await refuses(runtime.query('meetings.today.facts', {}, { actor: SYSTEM, orgId }))).not.toBeNull();
    // Nor does the facts read of one event of someone else's agenda answer.
    expect(await refuses(runtime.query('meetings.brief.facts', { meetingId: null, agendaId: ids.e1 }, { actor: asUser('rec'), orgId }))).toBe('AGENDA_NOT_FOUND');
  });

  it('says the calendar is not read when the member switched the read off, and does not fail the page for an event whose meeting the member no longer reads', async () => {
    await sqlAdmin(`UPDATE crove_kernel.calendar_connection SET read_events = false WHERE org_id = $1 AND id = $2`, [orgId, connection]);
    expect(await today('lan')).toEqual({ enabled: false, totalMinutes: 0, items: [] });
    await sqlAdmin(`UPDATE crove_kernel.calendar_connection SET read_events = true WHERE org_id = $1 AND id = $2`, [orgId, connection]);
    const stray = await event('Gắn nhầm họp riêng', `${VN_NINE} + interval '9 hours'`, 30, { meetingId: ids.hidden as string });
    const out = await today('lan');
    const item = out.items.find((i) => i.event.id === stray);
    expect(item?.brief.empty).toBe(true);
    expect(out.items).toHaveLength(4);
    await sqlAdmin('DELETE FROM crove_meetings.calendar_agenda WHERE org_id = $1 AND id = $2', [orgId, stray]);
  });
});

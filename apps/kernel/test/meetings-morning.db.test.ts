// SPDX-License-Identifier: AGPL-3.0-only
// The opt-in morning notice of the day's meetings (#3955, part B) on a real database: a member turns it on (a time of day in their own zone) and off, and sees only their own setting; the worker's sweep sends,
// once a day at the chosen time, one in-app notice and one mail that hold only the count of the day's meetings and a link (canary strings pin it: no title, no name); a day with no meeting, a time not come yet,
// a muted kind, a member who turned it off and a zone the database does not know send nothing; and a second sweep or a second dispatch for the same day sends nothing more.
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import { MORNING_KIND, type MorningState } from '@ludy/kernel-contract';
import { Runtime } from '@ludy/kernel-runtime';
import { meetingsCommands, meetingsQueries } from '@ludy/mod-meetings';
import { runMeetingsMorningSweep } from '../src/meetings-morning.ts';
import { TEST_MANIFESTS } from './invariant/fixtures/manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const SYSTEM = { type: 'system' as const, component: 'test.morning' };
const ZONE = 'Asia/Ho_Chi_Minh';
const SECRET_TITLE = 'Họp kín về hợp đồng Á Châu';

suite('the opt-in morning notice of the day\'s meetings (#3955)', () => {
  const dbName = `crove_test_morning_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  const pools: pg.Pool[] = [];
  let orgId = '';
  let runtime: Runtime;
  let worker: Runtime;
  let workerDb: Db;
  const users: Record<string, string> = {};
  const connections: Record<string, string> = {};
  const asMfa = (who: string) => ({ type: 'user' as const, userId: users[who] as string, aal: 'aal2' as const, mfaAt: Math.floor(Date.now() / 1000) });
  const asUser = (who: string) => ({ type: 'user' as const, userId: users[who] as string, aal: 'aal1' as const });
  const get = (who: string) => runtime.query<MorningState>('meetings.morning.get', {}, { actor: asUser(who), orgId });
  const set = (who: string, input: Record<string, unknown>) => runtime.execute<MorningState>('meetings.morning.set', input, { actor: asUser(who), orgId });
  const refuses = (promise: Promise<unknown>) => promise.then(() => null, (error: unknown) => (error as { code?: string }).code ?? 'ERR');
  const sweep = () => runMeetingsMorningSweep({ runtime: worker, workerDb });
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
  // The minute of the day it is now in a zone, and the day there.
  const localNow = async (zone: string) =>
    (await sqlAdmin<{ minute: number; day: string }>(`SELECT (date_part('hour', now() AT TIME ZONE $1) * 60 + date_part('minute', now() AT TIME ZONE $1))::int AS minute, (now() AT TIME ZONE $1)::date::text AS day`, [zone])).rows[0]!;
  const notices = async (who: string) => (await sqlAdmin<{ dedupe_key: string; detail: Record<string, string>; subject_id: string | null; kind: string }>(`SELECT dedupe_key, detail, subject_id, kind FROM ludy_kernel.notification WHERE org_id = $1 AND user_id = $2 AND kind = $3 ORDER BY created_at`, [orgId, users[who], MORNING_KIND])).rows;
  const mails = async () => (await sqlAdmin<{ to_address: string; subject: string | null; source: string; source_id: string | null; payload: Record<string, unknown>; status: string }>(`SELECT to_address, subject, source, source_id, payload, status FROM ludy_kernel.mail_message WHERE org_id = $1 AND template_key = 'meetings.morning' ORDER BY created_at`, [orgId])).rows;
  async function connect(who: string): Promise<string> {
    const id = crypto.randomUUID();
    await sqlAdmin(`INSERT INTO ludy_kernel.calendar_connection (org_id, id, user_id, provider, external_account, display_name, scopes, read_events) VALUES ($1, $2, $3, 'google', $4, $5, '{}', true)`, [orgId, id, users[who], `${who}@calendar.test`, who]);
    connections[who] = id;
    return id;
  }
  async function eventNow(who: string, title = SECRET_TITLE): Promise<void> {
    await sqlAdmin(
      `INSERT INTO ludy_meetings.calendar_agenda (org_id, connection_id, user_id, external_id, title, starts_at, ends_at, time_zone)
       VALUES ($1, $2, $3, $4, $5, now(), now() + interval '30 minutes', $6)`,
      [orgId, connections[who], users[who], crypto.randomUUID(), title, ZONE],
    );
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
    const login = (user: string, password: string) => {
      const url = new URL(adminUrl);
      url.username = user;
      url.password = password;
      return url.toString();
    };
    const appPool = createPool({ connectionString: login('ludy_app', 'test-app-pw'), max: 4 });
    const workerPool = createPool({ connectionString: login('ludy_worker', 'test-worker-pw'), max: 4 });
    pools.push(appPool, workerPool);
    workerDb = createDb(workerPool);
    const registry = { commands: [...kernelCommands, ...meetingsCommands], queries: [...kernelQueries({ inboundDomain: null }), ...meetingsQueries] };
    runtime = new Runtime(createDb(appPool), { manifests: TEST_MANIFESTS }).register(registry);
    worker = new Runtime(workerDb, { manifests: TEST_MANIFESTS }).register(registry);
    for (const key of ['owner', 'lan', 'nam', 'quiet', 'muted', 'odd', 'gone', 'busy', 'twin', 'pa', 'pb', 'pc', 'pd', 'racer']) users[key] = await upsertIdentity(createDb(appPool), { issuer: 'morning', subject: key, email: `${key}@morning.test`, name: key });
    orgId = (await createOrg(runtime, asUser('owner'), 'Công ty Buổi Sáng')).orgId;
    await sqlAdmin(`INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member'), ($1, $4, 'member'), ($1, $5, 'member'), ($1, $6, 'member'), ($1, $7, 'member'), ($1, $8, 'member')`, [orgId, users.lan, users.nam, users.quiet, users.muted, users.odd, users.gone, users.busy]);
    await sqlAdmin(`INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) SELECT $1, u, 'member' FROM unnest($2::uuid[]) u`, [orgId, [users.twin, users.pa, users.pb, users.pc, users.pd, users.racer]]);
  }, 300_000);

  afterAll(async () => {
    await Promise.all(pools.map((p) => p.end()));
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('is off until a member turns it on, shows a member only their own setting, and is turned off by deleting the row', async () => {
    expect(await get('lan')).toEqual({ enabled: false, minute: 420, timeZone: ZONE, language: 'vi' });
    expect(await set('lan', { enabled: true, minute: 450, timeZone: ZONE, language: 'en' })).toEqual({ enabled: true, minute: 450, timeZone: ZONE, language: 'en' });
    expect(await get('lan')).toEqual({ enabled: true, minute: 450, timeZone: ZONE, language: 'en' });
    // Nobody else sees it, an owner included; the system context reads no member's setting either.
    for (const who of ['owner', 'nam']) expect(await get(who), who).toMatchObject({ enabled: false });
    expect(await refuses(worker.query('meetings.morning.get', {}, { actor: SYSTEM, orgId }))).not.toBeNull();
    // Turning it on again changes the one row; defaults fill what the member left out.
    await set('lan', { enabled: true });
    expect(await get('lan')).toEqual({ enabled: true, minute: 420, timeZone: ZONE, language: 'vi' });
    expect((await sqlAdmin(`SELECT 1 FROM ludy_meetings.morning_notice WHERE org_id = $1 AND user_id = $2`, [orgId, users.lan])).rowCount).toBe(1);
    await set('lan', { enabled: false });
    expect(await get('lan')).toMatchObject({ enabled: false });
    expect((await sqlAdmin(`SELECT 1 FROM ludy_meetings.morning_notice WHERE org_id = $1 AND user_id = $2`, [orgId, users.lan])).rowCount).toBe(0);
  });

  it('refuses a time that is not a minute of the day and a zone that is not a zone', async () => {
    for (const bad of [{ minute: -1 }, { minute: 1440 }, { minute: 7.5 }, { timeZone: 'Mars/Olympus' }, { timeZone: '' }, { language: 'fr' }, { extra: 1 }]) {
      expect(await refuses(set('lan', { enabled: true, ...bad })), JSON.stringify(bad)).not.toBeNull();
    }
    expect(await get('lan')).toMatchObject({ enabled: false });
  });

  it('sends one in-app notice and one mail with only the count and a link, once a day, and a second pass or dispatch sends nothing more', async () => {
    await connect('lan');
    await eventNow('lan');
    await eventNow('lan', 'Cuộc họp thứ hai');
    const now = await localNow(ZONE);
    // A time that has come (ten minutes ago, or midnight).
    await set('lan', { enabled: true, minute: Math.max(0, now.minute - 10), timeZone: ZONE, language: 'vi' });
    const first = await sweep();
    expect(first).toMatchObject({ found: 1, sent: 1, failures: 0 });
    const mine = await notices('lan');
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ dedupe_key: `morning:${now.day}`, detail: { count: '2' }, subject_id: null });
    const sent = await mails();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to_address: 'lan@morning.test', source: 'meetings.morning', source_id: null, status: 'queued' });
    expect(sent[0]?.payload).toEqual({ lang: 'vi', org: 'Công ty Buổi Sáng', count: 2, path: expect.stringMatching(/^\/o\/[a-z0-9-]+\/meetings$/) });
    // No title, no name, no time: not in the notice, the mail, or the audit rows of the command.
    const audit = (await sqlAdmin<{ detail: unknown }>(`SELECT detail FROM ludy_kernel.audit_event WHERE org_id = $1 AND command = 'meetings.morning.notice'`, [orgId])).rows;
    for (const text of [JSON.stringify(mine), JSON.stringify(sent), JSON.stringify(audit)]) expect(text).not.toMatch(/Họp kín|Á Châu|hợp đồng|thứ hai/u);
    // The same day again: nothing new, by the sweep or by a dispatch of the same row.
    expect(await sweep()).toMatchObject({ found: 0, sent: 0 });
    expect(await worker.execute('meetings.morning.notice', { userId: users.lan, day: now.day }, { actor: SYSTEM, orgId })).toEqual({ notified: false, mailed: false });
    expect(await notices('lan')).toHaveLength(1);
    expect(await mails()).toHaveLength(1);
  });

  it('sends nothing before the chosen time, nothing on a day with no meeting, nothing to a member who muted the kind or turned it off, and nothing for a zone the database does not know', async () => {
    const now = await localNow(ZONE);
    // nam: has a meeting but chose a time that has not come (skipped near the end of the day, when there is no later minute to choose).
    await connect('nam');
    await eventNow('nam');
    if (now.minute <= 1380) await set('nam', { enabled: true, minute: now.minute + 30, timeZone: ZONE, language: 'vi' });
    // quiet: chose a time that has come but has no meeting today.
    await set('quiet', { enabled: true, minute: Math.max(0, now.minute - 10), timeZone: ZONE, language: 'vi' });
    await connect('quiet');
    // muted: has a meeting and a time that has come, and turned the kind off in the notification settings.
    await connect('muted');
    await eventNow('muted');
    await set('muted', { enabled: true, minute: Math.max(0, now.minute - 10), timeZone: ZONE, language: 'vi' });
    await sqlAdmin(`INSERT INTO ludy_kernel.notification_mute (org_id, user_id, kind) VALUES ($1, $2, $3)`, [orgId, users.muted, MORNING_KIND]);
    // odd: a zone name the database does not know, stored by hand: the sweep skips it and goes on.
    await connect('odd');
    await eventNow('odd');
    await sqlAdmin(`INSERT INTO ludy_meetings.morning_notice (org_id, user_id, send_minute, time_zone, language) VALUES ($1, $2, 0, 'Not/AZone', 'vi')`, [orgId, users.odd]);
    const before = (await mails()).length;
    expect(await sweep()).toMatchObject({ found: 0, sent: 0, failures: 0 });
    for (const who of ['nam', 'quiet', 'muted', 'odd']) expect(await notices(who), who).toHaveLength(0);
    expect((await mails()).length).toBe(before);
    // lan turns it off: the next day's notice would not be sent either.
    await set('lan', { enabled: false });
    expect(await sweep()).toMatchObject({ found: 0 });
  });

  it('is due in the member\'s own zone: the day and the hour are theirs, not Vietnam\'s', async () => {
    const zone = 'Pacific/Kiritimati';
    const now = await localNow(zone);
    await sqlAdmin(
      `INSERT INTO ludy_meetings.calendar_agenda (org_id, connection_id, user_id, external_id, title, starts_at, ends_at, time_zone)
       VALUES ($1, $2, $3, $4, 'Họp ở xa', now(), now() + interval '30 minutes', $5)`,
      [orgId, connections.quiet, users.quiet, crypto.randomUUID(), zone],
    );
    await set('quiet', { enabled: true, minute: Math.max(0, now.minute - 10), timeZone: zone, language: 'en' });
    expect(await sweep()).toMatchObject({ found: 1, sent: 1 });
    expect((await notices('quiet'))[0]?.dedupe_key).toBe(`morning:${now.day}`);
    const english = (await mails()).find((m) => m.to_address === 'quiet@morning.test');
    expect(english?.payload).toMatchObject({ lang: 'en', count: 1 });
    expect(english?.subject).toBe('You have meetings today');
  });

  it('drops a member\'s setting when they leave the org, so a later return finds it off, and leaves the others alone', async () => {
    await set('gone', { enabled: true, minute: 480, timeZone: ZONE, language: 'vi' });
    await set('owner', { enabled: true, minute: 480, timeZone: ZONE, language: 'vi' });
    const rows = (user: string) => sqlAdmin(`SELECT 1 FROM ludy_meetings.morning_notice WHERE org_id = $1 AND user_id = $2`, [orgId, users[user]]);
    expect((await rows('gone')).rowCount).toBe(1);
    await runtime.execute('kernel.member.remove', { userId: users.gone }, { actor: asMfa('owner'), orgId });
    expect((await rows('gone')).rowCount).toBe(0);
    expect((await rows('owner')).rowCount).toBe(1);
    // They come back (an invite accepted, here the row put back by hand): the old switch is not on.
    await sqlAdmin(`INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')`, [orgId, users.gone]);
    expect(await get('gone')).toMatchObject({ enabled: false });
  });

  it('caps the day\'s count at 1000, so a member with more events still gets a notice', async () => {
    await connect('busy');
    await sqlAdmin(
      `INSERT INTO ludy_meetings.calendar_agenda (org_id, connection_id, user_id, external_id, title, starts_at, ends_at, time_zone)
       SELECT $1, $2, $3, 'busy-' || g, 'Họp ' || g, now(), now() + interval '30 minutes', $4 FROM generate_series(1, 1005) g`,
      [orgId, connections.busy, users.busy, ZONE],
    );
    const now = await localNow(ZONE);
    await set('busy', { enabled: true, minute: Math.max(0, now.minute - 10), timeZone: ZONE, language: 'vi' });
    expect((await sqlAdmin<{ events: number }>(`SELECT events FROM ludy_meetings.morning_notices_due(10, $1, $2)`, [orgId, users.busy])).rows).toEqual([{ events: 1000 }]);
    expect(await sweep()).toMatchObject({ found: 1, sent: 1, failures: 0 });
    expect((await notices('busy'))[0]).toMatchObject({ detail: { count: '1000' } });
  });

  it('counts an event once when two connections of the same member cache it, and counts a different one beside it', async () => {
    const first = await connect('twin');
    const second = crypto.randomUUID();
    await sqlAdmin(`INSERT INTO ludy_kernel.calendar_connection (org_id, id, user_id, provider, external_account, display_name, scopes, read_events) VALUES ($1, $2, $3, 'google', 'twin-two@calendar.test', 'twin two', '{}', true)`, [orgId, second, users.twin]);
    // One meeting both calendars hold (same provider event id and start), and one only the second holds.
    await sqlAdmin(
      `INSERT INTO ludy_meetings.calendar_agenda (org_id, connection_id, user_id, external_id, title, starts_at, ends_at, time_zone)
       VALUES ($1, $2, $4, 'shared-event', 'Họp chung', now(), now() + interval '30 minutes', $5),
              ($1, $3, $4, 'shared-event', 'Họp chung', now(), now() + interval '30 minutes', $5),
              ($1, $3, $4, 'only-second', 'Họp riêng', now(), now() + interval '30 minutes', $5)`,
      [orgId, first, second, users.twin, ZONE],
    );
    const now = await localNow(ZONE);
    await set('twin', { enabled: true, minute: Math.max(0, now.minute - 10), timeZone: ZONE, language: 'vi' });
    expect((await sqlAdmin<{ events: number }>(`SELECT events FROM ludy_meetings.morning_notices_due(10, $1, $2)`, [orgId, users.twin])).rows).toEqual([{ events: 2 }]);
  });

  it('hands out the due members in no fixed order, so a pass that is cut short does not give the same first ones every time', async () => {
    const who = ['pa', 'pb', 'pc', 'pd'];
    const now = await localNow(ZONE);
    for (const key of who) {
      await connect(key);
      await eventNow(key);
      await set(key, { enabled: true, minute: Math.max(0, now.minute - 10), timeZone: ZONE, language: 'vi' });
    }
    // One row a call, as a pass of one would take: with a fixed order the same member would come back every time. Other due members of the org may come too; every one of the four must show up.
    const seen = new Set<string>();
    await admin(async (c) => {
      for (let call = 0; call < 150; call += 1) {
        const rows = (await c.query<{ user_id: string }>(`SELECT user_id FROM ludy_meetings.morning_notices_due(1, $1)`, [orgId])).rows;
        expect(rows).toHaveLength(1);
        seen.add(rows[0]!.user_id);
      }
    });
    for (const key of who) expect(seen.has(users[key] as string), `${key} was handed out`).toBe(true);
  });

  it('waits for a removal of the member in flight and is refused once they are gone, so a save cannot outlive the trigger that drops the setting', async () => {
    const holder = new pg.Client({ connectionString: adminUrl });
    await holder.connect();
    try {
      await holder.query('BEGIN');
      // The removal is under way: the membership row is deleted but not committed (the trigger has dropped the setting, which was never there).
      await holder.query(`DELETE FROM ludy_kernel.tenant_member WHERE org_id = $1 AND user_id = $2`, [orgId, users.racer]);
      let settled = false;
      const saving = refuses(set('racer', { enabled: true, minute: 480, timeZone: ZONE, language: 'vi' })).then((code) => {
        settled = true;
        return code;
      });
      await new Promise((resolve) => setTimeout(resolve, 800));
      expect(settled, 'the save waits for the removal').toBe(false);
      await holder.query('COMMIT');
      expect(await saving).toBe('FORBIDDEN');
    } finally {
      await holder.end();
    }
    expect((await sqlAdmin(`SELECT 1 FROM ludy_meetings.morning_notice WHERE org_id = $1 AND user_id = $2`, [orgId, users.racer])).rowCount).toBe(0);
  });
});

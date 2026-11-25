// SPDX-License-Identifier: AGPL-3.0-only
// The week's meeting load (#4770) on a real database: it is for an owner and an admin only, it is read under the caller's own row security (an owner and an admin have no extra right to read a meeting, so an
// attendees-only meeting they are no reader of is not counted, not even in a series), a meeting with no length or past its text date counts for nothing, an overlap counts once, and the recurring series that
// may be worth trimming come out of fixed signals with no text in the answer.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import type { LoadWeek } from '@ludy/kernel-contract';
import { Runtime } from '@ludy/kernel-runtime';
import { meetingsCommands, meetingsQueries } from '@ludy/mod-meetings';
import { TEST_MANIFESTS } from './invariant/fixtures/manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

// Last week's Wednesday 10:00 in Vietnam, whatever day it is now: inside the week weeksBack = 1 asks for, with room on both sides for a meeting an hour or a day away.
const LAST_WEDNESDAY = `((date_trunc('week', now() AT TIME ZONE 'Asia/Ho_Chi_Minh') - interval '7 days' + interval '2 days 10 hours') AT TIME ZONE 'Asia/Ho_Chi_Minh')`;

suite('The week\'s meeting load (#4770)', () => {
  const dbName = `ludy_test_load_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  const pools: pg.Pool[] = [];
  let orgId = '';
  let runtime: Runtime;
  const users: Record<string, string> = {};
  const asUser = (who: string) => ({ type: 'user' as const, userId: users[who] as string, aal: 'aal1' as const });
  const load = (who: string, weeksBack = 1) => runtime.query<LoadWeek>('meetings.load.week', { weeksBack }, { actor: asUser(who), orgId });
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

  interface MeetingSpec {
    title: string;
    recorder: string;
    readers?: string[];
    visibility?: 'attendees' | 'org';
    // When it started, as an SQL expression; its length in seconds (null: no length and no end).
    startedAt: string;
    seconds?: number | null;
    series?: string;
    textDay?: string;
  }
  async function meeting(spec: MeetingSpec): Promise<string> {
    const id = randomUUID();
    const seconds = spec.seconds === undefined ? 1800 : spec.seconds;
    await sqlAdmin(
      `INSERT INTO ludy_meetings.meeting (org_id, id, title, language, started_at, ended_at, length_seconds, recorder_user_id, visibility, status, consent_method, consent_confirmed_by, consent_confirmed_at, consent_notice_version, audio_retention_date, text_retention_date, series_id)
       VALUES ($1, $2, $4, 'vi', ${spec.startedAt}, ${seconds === null ? 'NULL' : `${spec.startedAt} + ($5 || ' seconds')::interval`}, $5::int, $3, $6, 'ready', 'told_at_start', $3, now(), '1.0', current_date - 1, ${spec.textDay ?? 'current_date + 365'}, $7)`,
      [orgId, id, users[spec.recorder], spec.title, seconds, spec.visibility ?? 'attendees', spec.series ?? null],
    );
    for (const reader of spec.readers ?? []) await sqlAdmin('INSERT INTO ludy_meetings.meeting_reader (org_id, id, meeting_id, user_id) VALUES ($1, $2, $3, $4)', [orgId, randomUUID(), id, users[reader]]);
    return id;
  }
  const published = (meetingId: string) =>
    sqlAdmin(`INSERT INTO ludy_meetings.meeting_result (org_id, meeting_id, summary, decisions, feature, stage) VALUES ($1, $2, 'Tóm tắt bí mật của cuộc họp', '["Quyết định bí mật"]'::jsonb, 'manual', 'published')`, [orgId, meetingId]);
  const openItem = (meetingId: string, title: string) =>
    sqlAdmin(
      `INSERT INTO ludy_meetings.action_item (org_id, id, meeting_id, title, who_drafted, who_parsed, when_drafted, stage, status, task_id, tainted, transcript_seconds)
       VALUES ($1, $2, $3, $4, 'Lan', NULL, 'thứ sáu', 'published', 'suggested', NULL, false, 10)`,
      [orgId, randomUUID(), meetingId, title],
    );
  // A recurring series: `count` meetings, one a week from a week and a day ago back, the latest first named `${name} 1`.
  const weekly = async (name: string, series: string, count: number, spec: Omit<MeetingSpec, 'title' | 'startedAt' | 'series'>) => {
    const ids: string[] = [];
    for (let n = 1; n <= count; n++) ids.push(await meeting({ ...spec, title: `${name} ${n}`, startedAt: `now() - interval '${n * 7 + 1} days'`, series }));
    return ids;
  };

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
    const appPool = createPool({ connectionString: url.toString(), max: 4 });
    pools.push(appPool);
    const db = createDb(appPool);
    runtime = new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands, ...meetingsCommands], queries: [...kernelQueries({ inboundDomain: null }), ...meetingsQueries] });
    for (const key of ['owner', 'adm', 'rec', 'lan', 'hung']) users[key] = await upsertIdentity(db, { issuer: 'load', subject: key, email: `${key}@load.test`, name: key });
    orgId = (await createOrg(runtime, asUser('owner'), 'Công ty Giao Ban')).orgId;
    await sqlAdmin(`INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'member'), ($1, $5, 'member')`, [orgId, users.adm, users.rec, users.lan, users.hung]);
  }, 300_000);

  afterAll(async () => {
    await Promise.all(pools.map((p) => p.end()));
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('is refused to a member and answers an owner and an admin', async () => {
    await expect(load('rec')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(load('lan')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await load('owner')).toMatchObject({ weeksBack: 1, members: [], series: [], seriesCut: false });
    expect(await load('adm')).toMatchObject({ weeksBack: 1, members: [] });
    await expect(runtime.query('meetings.load.week', { weeksBack: 13 }, { actor: asUser('owner'), orgId })).rejects.toThrow();
  });

  it('counts, per member, the meetings an owner and an admin read, an overlap once, and nothing they do not read or that has no length or is gone', async () => {
    await meeting({ title: 'Giao ban sáng', recorder: 'rec', readers: ['lan'], visibility: 'org', startedAt: `${LAST_WEDNESDAY}`, seconds: 3600 });
    // Starts half an hour into the first: the recorder is in both, so their time is 90 minutes, not 120.
    await meeting({ title: 'Họp nhanh', recorder: 'rec', visibility: 'org', startedAt: `${LAST_WEDNESDAY} + interval '30 minutes'`, seconds: 3600 });
    await meeting({ title: 'Họp khách hàng', recorder: 'hung', visibility: 'org', startedAt: `${LAST_WEDNESDAY} + interval '1 day'`, seconds: 1800 });
    // Not read by the owner or the admin: attendees only, and neither is the recorder or a reader.
    await meeting({ title: 'Họp riêng của anh Hùng', recorder: 'hung', readers: ['lan'], startedAt: `${LAST_WEDNESDAY} + interval '2 hours'`, seconds: 7200 });
    // No length, past its text date, and outside the week.
    await meeting({ title: 'Chưa ghi xong', recorder: 'rec', visibility: 'org', startedAt: `${LAST_WEDNESDAY} + interval '3 hours'`, seconds: null });
    await meeting({ title: 'Đã hết hạn lưu', recorder: 'rec', visibility: 'org', startedAt: `${LAST_WEDNESDAY} + interval '4 hours'`, textDay: 'current_date - 1' });
    await meeting({ title: 'Tuần trước nữa', recorder: 'rec', visibility: 'org', startedAt: `${LAST_WEDNESDAY} - interval '7 days'` });

    const owner = await load('owner');
    expect(owner.meetings).toBe(3);
    expect(owner.personMinutes).toBe(180);
    expect(owner.members).toEqual([
      { userId: users.rec, meetings: 2, minutes: 90 },
      { userId: users.lan, meetings: 1, minutes: 60 },
      { userId: users.hung, meetings: 1, minutes: 30 },
    ]);
    // An admin has the same row security: the same figures.
    expect((await load('adm')).members).toEqual(owner.members);
    // The week before is another window.
    expect((await load('owner', 2)).members).toEqual([{ userId: users.rec, meetings: 1, minutes: 30 }]);
    expect((await load('owner', 0)).members).toEqual([]);
    // The word "week" is Monday to Sunday: the answer names both ends.
    expect(owner.weekStart < owner.weekEnd).toBe(true);
    expect(new Date(`${owner.weekStart}T00:00:00Z`).getUTCDay()).toBe(1);
    expect(new Date(`${owner.weekEnd}T00:00:00Z`).getUTCDay()).toBe(0);
    // The recorder is no owner or admin, so the query refuses them, but a meeting they are in is a person's own business: nothing here answers a member.
    await expect(load('hung')).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('lists the recurring series that may be worth trimming, with the signals, and none of what an owner may not read', async () => {
    const quiet = randomUUID();
    const healthy = randomUUID();
    const piling = randomUUID();
    const tooFew = randomUUID();
    const hidden = randomUUID();
    // Four attendees-only meetings with nobody but the recorder (the owner, so the owner reads them) and no minutes: two signals. An admin is no reader of them.
    await weekly('Họp tuần một mình', quiet, 4, { recorder: 'owner', visibility: 'attendees', seconds: 1800 });
    // Org-wide meetings have no reader rows (everyone reads them), so who attended is unknown: with minutes published each time there is nothing to say, and above all no "only the recorder" signal.
    const orgWide = randomUUID();
    for (const id of await weekly('Họp cả tổ chức', orgWide, 4, { recorder: 'rec', visibility: 'org', seconds: 1800 })) await published(id);
    // Readers added and minutes published each time, no open item: nothing to say.
    for (const id of await weekly('Họp khỏe', healthy, 3, { recorder: 'rec', readers: ['lan'], visibility: 'org', seconds: 2700 })) await published(id);
    // Readers and minutes, but the last two meetings each leave three open items.
    const pilingIds = await weekly('Họp dồn việc', piling, 3, { recorder: 'rec', readers: ['lan'], visibility: 'org', seconds: 3600 });
    for (const id of pilingIds) await published(id);
    for (const id of pilingIds.slice(0, 2)) for (const n of [1, 2, 3]) await openItem(id, `Việc bí mật ${n}`);
    // Two meetings only.
    await weekly('Họp hai lần', tooFew, 2, { recorder: 'rec', visibility: 'org' });
    // A series the owner reads none of: attendees only, recorded by someone else.
    await weekly('Họp kín của anh Hùng', hidden, 5, { recorder: 'hung', readers: ['lan'] });

    const owner = await load('owner');
    expect(owner.series.map((s) => [s.title, s.signals])).toEqual([
      ['Họp tuần một mình 1', ['few_people', 'no_minutes']],
      ['Họp dồn việc 1', ['items_piling']],
    ]);
    expect(owner.series[0]).toMatchObject({ seriesId: quiet, meetings: 4, averageMinutes: 30, soloMeetings: 4, withMinutes: 0, openItems: [0, 0] });
    expect(owner.series[1]).toMatchObject({ seriesId: piling, meetings: 3, averageMinutes: 60, soloMeetings: 0, withMinutes: 3, openItems: [3, 3] });
    expect(owner.seriesCut).toBe(false);
    // No text of a result or an item and no title of a meeting the owner does not read.
    const answer = JSON.stringify(owner);
    for (const secret of ['bí mật', 'Họp kín', 'Họp khỏe', 'Họp hai lần', 'Họp cả tổ chức']) expect(answer, secret).not.toContain(secret);
    // An admin has the same row security: the series they read (the org-wide one that piles up), not the owner's own attendees-only one.
    expect((await load('adm')).series).toEqual([owner.series[1]]);
    await expect(load('lan')).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('leaves an audit row for the read, with no figure or title in it', async () => {
    await load('owner');
    const audit = await sqlAdmin<{ row: string }>(`SELECT audit_event::text AS row FROM ludy_kernel.audit_event WHERE org_id = $1 AND audit_event::text LIKE '%meetings.load.week%'`, [orgId]);
    expect(audit.rows.length).toBeGreaterThan(0);
    for (const secret of ['Họp tuần một mình', 'bí mật', 'Họp riêng']) expect(audit.rows.map((r) => r.row).join('\n'), secret).not.toContain(secret);
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
// Links of a meeting to a party, a deal and a calendar event (L1, #2587, ADR-0024, ADR-0047) on PostgreSQL 17: the recorder sets and removes them (removal audited with
// ids only), a deal is checked through the CRM module and cannot be linked without it, a meeting has at most one deal, a party's, a deal's or an event's page reads only
// the meetings its viewer reads (a non-reader, a viewer and an agent get no row and no title of an attendees-only meeting), and deleting the meeting deletes its links.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import type { Deal, MeetingLink, MeetingOfTarget } from '@crove/kernel-contract';
import { Runtime } from '@crove/kernel-runtime';
import { crmCommands, crmQueries } from '@crove/mod-crm';
import { meetingsCommands, meetingsQueries } from '@crove/mod-meetings';
import { TEST_MANIFESTS } from './invariant/fixtures/manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const SECRET_TITLE = 'Họp kín về lương của anh Tuấn';

suite('meeting links on PostgreSQL (#2587)', () => {
  const dbName = `crove_test_meeting_links_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let rt: Runtime;
  let rtNoCrm: Runtime;
  let orgId = '';
  const users: Record<string, string> = {};
  const asUser = (who: string) => ({ type: 'user' as const, userId: users[who] as string, aal: 'aal1' as const });
  const exec = <T>(who: string, name: string, input: unknown, runtime = rt) => runtime.execute<T>(name, input, { actor: asUser(who), orgId });
  const query = <T>(who: string, name: string, input: unknown, runtime = rt) => runtime.query<T>(name, input, { actor: asUser(who), orgId });
  const refuses = async (promise: Promise<unknown>) => promise.then(() => null, (error: unknown) => (error as { code?: string }).code ?? 'ERR');

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  const meeting = async (recorder: string, title: string, visibility: 'attendees' | 'org' = 'attendees'): Promise<string> => {
    const id = randomUUID();
    await admin((c) =>
      c.query(
        `INSERT INTO crove_meetings.meeting (org_id, id, title, language, started_at, recorder_user_id, visibility, status, consent_method, consent_confirmed_by, consent_confirmed_at, consent_notice_version, audio_retention_date, text_retention_date)
         VALUES ($1, $2, $3, 'vi', now(), $4, $5, 'ready', 'told_at_start', $4, now(), '1.0', current_date + 30, current_date + 365)`,
        [orgId, id, title, users[recorder], visibility],
      ),
    );
    return id;
  };
  const party = (name: string) => admin((c) => c.query<{ id: string }>("INSERT INTO crove_kernel.party (org_id, name, kind) VALUES ($1, $2, 'organization') RETURNING id", [orgId, name]).then((r) => r.rows[0]!.id));
  const event = (who: string) =>
    admin((c) =>
      c.query<{ id: string }>(
        "INSERT INTO crove_kernel.calendar_event (org_id, user_id, starts_at, ends_at, time_zone, title, kind, created_by) VALUES ($1, $2, now(), now() + interval '1 hour', 'Asia/Ho_Chi_Minh', 'Gặp khách', 'manual', $2) RETURNING id",
        [orgId, users[who]],
      ).then((r) => r.rows[0]!.id),
    );
  const deal = async (who: string, partyId: string) => {
    await exec(who, 'crm.pipeline.setup', {});
    return (await exec<Deal>(who, 'crm.deal.create', { partyId, title: 'Gói kế toán năm', amount: '15000000', expectedClose: '2026-12-31' })).id;
  };
  const linkCount = (meetingId: string) => admin((c) => c.query<{ n: string }>('SELECT count(*)::text AS n FROM crove_meetings.meeting_link WHERE org_id = $1 AND meeting_id = $2', [orgId, meetingId]).then((r) => Number(r.rows[0]!.n)));
  const audits = (command: string, meetingId: string) =>
    admin((c) => c.query<{ detail: Record<string, unknown>; actor_id: string | null }>(`SELECT detail, actor_id FROM crove_kernel.audit_event WHERE org_id = $1 AND command = $2 AND detail ->> 'meetingId' = $3 ORDER BY occurred_at`, [orgId, command, meetingId]).then((r) => r.rows));

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
    const login = new URL(adminUrl);
    login.username = 'crove_app';
    login.password = 'test-app-pw';
    pool = createPool({ connectionString: login.toString(), max: 4 });
    const db = createDb(pool);
    rt = new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands, ...crmCommands, ...meetingsCommands], queries: [...kernelQueries({ inboundDomain: null }), ...crmQueries, ...meetingsQueries] });
    // A deployment without the CRM module: its queries are not installed.
    rtNoCrm = new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands, ...meetingsCommands], queries: [...kernelQueries({ inboundDomain: null }), ...meetingsQueries] });
    for (const key of ['owner', 'recorder', 'attendee', 'other', 'viewer']) {
      users[key] = await upsertIdentity(db, { issuer: 'links', subject: key, email: `${key}@links.test`, name: null });
    }
    orgId = (await createOrg(rt, asUser('owner'), 'Links')).orgId;
    await admin((c) =>
      c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member'), ($1, $4, 'member'), ($1, $5, 'viewer')", [orgId, users.recorder, users.attendee, users.other, users.viewer]),
    );
  }, 300_000);

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('links a meeting to a party, a deal and a calendar event, and each target lists the meeting', async () => {
    const m = await meeting('recorder', 'Họp báo giá');
    const p = await party('Công ty ABC');
    const d = await deal('recorder', p);
    const e = await event('recorder');
    const linkParty = await exec<MeetingLink>('recorder', 'meetings.link.add', { meetingId: m, kind: 'party', targetId: p });
    const linkDeal = await exec<MeetingLink>('recorder', 'meetings.link.add', { meetingId: m, kind: 'deal', targetId: d });
    const linkEvent = await exec<MeetingLink>('recorder', 'meetings.link.add', { meetingId: m, kind: 'calendar_event', targetId: e });
    expect(linkParty).toMatchObject({ meetingId: m, kind: 'party', targetId: p, createdBy: users.recorder });
    expect(linkDeal).toMatchObject({ kind: 'deal', targetId: d });
    expect(linkEvent).toMatchObject({ kind: 'calendar_event', targetId: e });
    expect((await query<MeetingLink[]>('recorder', 'meetings.link.list', { meetingId: m })).map((l) => l.kind).sort()).toEqual(['calendar_event', 'deal', 'party']);
    for (const [kind, targetId] of [['party', p], ['deal', d], ['calendar_event', e]] as const) {
      const page = await query<MeetingOfTarget[]>('recorder', 'meetings.link.by_target', { kind, targetId });
      expect(page, kind).toEqual([expect.objectContaining({ meetingId: m, title: 'Họp báo giá', recorderUserId: users.recorder })]);
    }
    // The same link again is the same link: no second row, no second audit row.
    expect((await exec<MeetingLink>('recorder', 'meetings.link.add', { meetingId: m, kind: 'party', targetId: p })).id).toBe(linkParty.id);
    expect(await linkCount(m)).toBe(3);
    expect((await audits('meetings.link.add', m)).length).toBe(3);
  });

  it('allows one deal per meeting and refuses a target that is not there', async () => {
    const m = await meeting('recorder', 'Họp hai cơ hội');
    const p = await party('Công ty XYZ');
    const d1 = await deal('recorder', p);
    const d2 = await deal('recorder', p);
    await exec('recorder', 'meetings.link.add', { meetingId: m, kind: 'deal', targetId: d1 });
    expect(await refuses(exec('recorder', 'meetings.link.add', { meetingId: m, kind: 'deal', targetId: d2 }))).toBe('MEETING_HAS_DEAL');
    // Two parties are fine.
    await exec('recorder', 'meetings.link.add', { meetingId: m, kind: 'party', targetId: p });
    await exec('recorder', 'meetings.link.add', { meetingId: m, kind: 'party', targetId: await party('Công ty thứ hai') });
    expect(await refuses(exec('recorder', 'meetings.link.add', { meetingId: m, kind: 'party', targetId: randomUUID() }))).toBe('LINK_TARGET_NOT_FOUND');
    expect(await refuses(exec('recorder', 'meetings.link.add', { meetingId: m, kind: 'deal', targetId: randomUUID() }))).toBe('LINK_TARGET_NOT_FOUND');
    expect(await refuses(exec('recorder', 'meetings.link.add', { meetingId: m, kind: 'calendar_event', targetId: randomUUID() }))).toBe('LINK_TARGET_NOT_FOUND');
    // Someone else's calendar event is not the recorder's to link (the calendar's own policy hides it).
    expect(await refuses(exec('recorder', 'meetings.link.add', { meetingId: m, kind: 'calendar_event', targetId: await event('other') }))).toBe('LINK_TARGET_NOT_FOUND');
    expect(await linkCount(m)).toBe(3);
  });

  it('refuses a non-manual calendar block as the meeting\'s event, and replaces the link to a deleted deal', async () => {
    const m = await meeting('recorder', 'Họp lịch đồng bộ');
    // Only an event the recorder made (manual or a booking's) can be the meeting's: a time-off block, like a synced busy block (kinds the calendar rewrites), cannot.
    const timeOff = await admin((c) =>
      c.query<{ id: string }>(
        "INSERT INTO crove_kernel.calendar_event (org_id, user_id, starts_at, ends_at, time_zone, title, kind, created_by) VALUES ($1, $2, now(), now() + interval '1 hour', 'Asia/Ho_Chi_Minh', NULL, 'time_off', $2) RETURNING id",
        [orgId, users.recorder],
      ).then((r) => r.rows[0]!.id),
    );
    expect(await refuses(exec('recorder', 'meetings.link.add', { meetingId: m, kind: 'calendar_event', targetId: timeOff }))).toBe('LINK_TARGET_NOT_FOUND');
    // A deal that is deleted leaves its link: a new deal replaces it instead of being refused.
    const p = await party('Công ty có cơ hội bị xóa');
    const d1 = await deal('recorder', p);
    await exec('recorder', 'meetings.link.add', { meetingId: m, kind: 'deal', targetId: d1 });
    await exec('recorder', 'crm.deal.delete', { dealId: d1 });
    const d2 = await deal('recorder', p);
    expect((await exec<MeetingLink>('recorder', 'meetings.link.add', { meetingId: m, kind: 'deal', targetId: d2 })).targetId).toBe(d2);
    expect((await query<MeetingLink[]>('recorder', 'meetings.link.list', { meetingId: m })).filter((l) => l.kind === 'deal').map((l) => l.targetId)).toEqual([d2]);
  });

  it('cannot link a deal in a deployment without the CRM module', async () => {
    const m = await meeting('recorder', 'Họp không CRM');
    expect(await refuses(exec('recorder', 'meetings.link.add', { meetingId: m, kind: 'deal', targetId: randomUUID() }, rtNoCrm))).toBe('DEAL_LINK_UNAVAILABLE');
    // A party still links.
    await exec('recorder', 'meetings.link.add', { meetingId: m, kind: 'party', targetId: await party('Công ty không CRM') }, rtNoCrm);
    expect(await linkCount(m)).toBe(1);
  });

  it('is the recorder\'s to set and remove: a reader, a non-reader and a viewer are refused', async () => {
    const m = await meeting('recorder', 'Họp của người ghi');
    const p = await party('Công ty riêng');
    await exec('recorder', 'meetings.reader.add', { meetingId: m, userId: users.attendee });
    expect(await refuses(exec('attendee', 'meetings.link.add', { meetingId: m, kind: 'party', targetId: p }))).toBe('FORBIDDEN');
    // A member who does not read the meeting cannot tell it exists.
    expect(await refuses(exec('other', 'meetings.link.add', { meetingId: m, kind: 'party', targetId: p }))).toBe('MEETING_NOT_FOUND');
    expect(await refuses(exec('viewer', 'meetings.link.add', { meetingId: m, kind: 'party', targetId: p }))).toBe('FORBIDDEN');
    // The owner of the org does not read an attendees-only meeting either, so cannot link or unlink it.
    expect(await refuses(exec('owner', 'meetings.link.add', { meetingId: m, kind: 'party', targetId: p }))).toBe('MEETING_NOT_FOUND');
    const link = await exec<MeetingLink>('recorder', 'meetings.link.add', { meetingId: m, kind: 'party', targetId: p });
    expect(await refuses(exec('attendee', 'meetings.link.remove', { meetingId: m, linkId: link.id }))).toBe('FORBIDDEN');
    expect(await refuses(exec('other', 'meetings.link.remove', { meetingId: m, linkId: link.id }))).toBe('MEETING_NOT_FOUND');
    expect(await linkCount(m)).toBe(1);
  });

  it('removes a link with an audit row of ids only, and refuses one that is not there', async () => {
    const m = await meeting('recorder', SECRET_TITLE);
    const p = await party('Công ty gỡ liên kết');
    const link = await exec<MeetingLink>('recorder', 'meetings.link.add', { meetingId: m, kind: 'party', targetId: p });
    expect(await exec('recorder', 'meetings.link.remove', { meetingId: m, linkId: link.id })).toEqual({ meetingId: m, linkId: link.id, removed: true });
    expect(await linkCount(m)).toBe(0);
    expect(await refuses(exec('recorder', 'meetings.link.remove', { meetingId: m, linkId: link.id }))).toBe('LINK_NOT_FOUND');
    const removed = await audits('meetings.link.remove', m);
    expect(removed).toHaveLength(1);
    expect(removed[0]).toMatchObject({ actor_id: users.recorder, detail: { meetingId: m, linkId: link.id, kind: 'party', targetId: p, removed: true } });
    // Neither audit row holds the title.
    for (const row of [...removed, ...(await audits('meetings.link.add', m))]) expect(JSON.stringify(row.detail)).not.toContain('lương');
  });

  it('shows a target\'s page only the meetings its viewer reads: no row and no title of an attendees-only meeting for anyone else', async () => {
    const p = await party('Công ty trang khách');
    const d = await deal('recorder', p);
    const secret = await meeting('recorder', SECRET_TITLE, 'attendees');
    const shared = await meeting('recorder', 'Họp chung', 'org');
    // Both meetings are linked to the party and the deal.
    for (const m of [secret, shared]) {
      await exec('recorder', 'meetings.link.add', { meetingId: m, kind: 'deal', targetId: d });
      await exec('recorder', 'meetings.link.add', { meetingId: m, kind: 'party', targetId: p });
    }
    const seen = async (who: string) => (await query<MeetingOfTarget[]>(who, 'meetings.link.by_target', { kind: 'party', targetId: p })).map((r) => r.title).sort();
    // The recorder reads both. A member who is not a reader reads the shared one only, the owner too (an owner has no extra right to an attendees-only meeting).
    expect(await seen('recorder')).toEqual(['Họp chung', SECRET_TITLE].sort());
    expect(await seen('other')).toEqual(['Họp chung']);
    expect(await seen('owner')).toEqual(['Họp chung']);
    const dealPage = async (who: string) => (await query<MeetingOfTarget[]>(who, 'meetings.link.by_target', { kind: 'deal', targetId: d })).map((r) => r.title).sort();
    // The deal page, which is the acceptance criterion: its readers see their meetings, and nobody else sees a row or a title of the others.
    expect(await dealPage('recorder')).toEqual(['Họp chung', SECRET_TITLE].sort());
    expect(await dealPage('other')).toEqual(['Họp chung']);
    expect(await dealPage('owner')).toEqual(['Họp chung']);
    expect(JSON.stringify(await dealPage('other'))).not.toContain('lương');
    // A reader added by the recorder sees it; one removed no longer does.
    await exec('recorder', 'meetings.reader.add', { meetingId: secret, userId: users.attendee });
    expect(await seen('attendee')).toEqual(['Họp chung', SECRET_TITLE].sort());
    expect(await dealPage('attendee')).toEqual(['Họp chung', SECRET_TITLE].sort());
    await exec('recorder', 'meetings.reader.remove', { meetingId: secret, userId: users.attendee });
    expect(await seen('attendee')).toEqual(['Họp chung']);
    // The links of a meeting are its readers' alone as well.
    expect(await query<MeetingLink[]>('other', 'meetings.link.list', { meetingId: secret })).toEqual([]);
    // A viewer and an agent (any other actor) read nothing at all.
    expect(await refuses(query('viewer', 'meetings.link.by_target', { kind: 'party', targetId: p }))).toBe('FORBIDDEN');
    expect(await refuses(rt.query('meetings.link.by_target', { kind: 'party', targetId: p }, { actor: { type: 'system', component: 'test' }, orgId }))).not.toBeNull();
    // Another org reads none of it.
    const otherOrg = (await createOrg(rt, asUser('other'), 'Another')).orgId;
    expect(await rt.query('meetings.link.by_target', { kind: 'party', targetId: p }, { actor: asUser('other'), orgId: otherOrg })).toEqual([]);
  });

  it('deletes the links with the meeting', async () => {
    const m = await meeting('recorder', 'Họp sắp xóa');
    await exec('recorder', 'meetings.link.add', { meetingId: m, kind: 'party', targetId: await party('Công ty xóa') });
    expect(await linkCount(m)).toBe(1);
    await exec('recorder', 'meetings.meeting.delete', { meetingId: m });
    expect(await linkCount(m)).toBe(0);
  });
});

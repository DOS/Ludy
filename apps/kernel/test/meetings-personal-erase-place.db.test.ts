// SPDX-License-Identifier: AGPL-3.0-only
// The place of a meeting is personal data (#5014, refs #5013), on a real database through kernel.personal_data.find, notify and erase: a place that holds a person's value is listed where the actor reads
// the meeting and counted per recorder where the owner cannot; the erasure redacts it by the rule of a meeting title (at once where the owner reads it, after a notice and 24 hours where not), and a place
// added or changed after a notice moves the stamp so the notice no longer covers it. CANARY values: the emails below must never appear in an answer for a meeting the caller cannot read.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import type { PersonalDataErasure, PersonalDataNotice, PersonalDataResult } from '@ludy/kernel-contract';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import { Runtime } from '@ludy/kernel-runtime';
import { meetingsCommands, meetingsQueries, setSummaryEnabled } from '@ludy/mod-meetings';
import { TEST_MANIFESTS } from './invariant/fixtures/manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

const EMAIL = 'nhan.rieng@khach.example';
const MARK = '[đã xóa]';

suite('the place of a meeting in the personal-data finder and the erasure (#5014)', () => {
  const dbName = `ludy_test_meetings_place_erase_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  const pools: pg.Pool[] = [];
  let orgId = '';
  let otherOrgId = '';
  let runtime: Runtime;
  const users: Record<string, string> = {};
  const asUser = (who: string) => ({ type: 'user' as const, userId: users[who] as string, aal: 'aal1' as const });
  const asMfa = (who: string) => ({ type: 'user' as const, userId: users[who] as string, aal: 'aal2' as const, sessionId: randomUUID(), mfaAt: Math.floor(Date.now() / 1000) });
  const find = (who: string, value = EMAIL) => runtime.execute<PersonalDataResult>('kernel.personal_data.find', { value }, { actor: asUser(who), orgId, idempotencyKey: randomUUID() });
  const notify = (value = EMAIL) => runtime.execute<PersonalDataNotice>('kernel.personal_data.notify', { value }, { actor: asUser('owner'), orgId, idempotencyKey: randomUUID() });
  const erase = (value = EMAIL) => runtime.execute<PersonalDataErasure>('kernel.personal_data.erase', { value }, { actor: asMfa('owner'), orgId, idempotencyKey: randomUUID() });
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

  async function meeting(recorder: string, title: string, visibility: 'attendees' | 'org', readers: string[] = [], org = orgId): Promise<string> {
    const id = randomUUID();
    await sqlAdmin(
      `INSERT INTO ludy_meetings.meeting (org_id, id, title, language, started_at, ended_at, length_seconds, recorder_user_id, visibility, status, consent_method, consent_confirmed_by, consent_confirmed_at, consent_notice_version, audio_retention_date, text_retention_date)
       VALUES ($1, $2, $3, 'vi', '2026-11-10T03:00:00Z', '2026-11-10T03:30:00Z', 1800, $4, $5, 'ready', 'told_at_start', $4, now(), '1.0', current_date + 20, current_date + 365)`,
      [org, id, title, users[recorder], visibility],
    );
    for (const reader of readers) await sqlAdmin(`INSERT INTO ludy_meetings.meeting_reader (org_id, id, meeting_id, user_id) VALUES ($1, $2, $3, $4)`, [org, randomUUID(), id, users[reader]]);
    return id;
  }
  const erasedRows = (e: PersonalDataErasure, column: string) => e.erased.find((r) => r.column === column)?.rows ?? 0;

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
    runtime = new Runtime(createDb(pool), { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands, ...meetingsCommands], queries: [...kernelQueries({ inboundDomain: null }), ...meetingsQueries] });
    setSummaryEnabled(false);
    for (const key of ['owner', 'admin', 'recorder', 'attendee', 'outsider']) users[key] = await upsertIdentity(createDb(pool), { issuer: 'meetings-place-erase', subject: key, email: `${key}@meetings-place-erase.test`, name: null });
    orgId = (await createOrg(runtime, asUser('owner'), 'Nơi họp trong họp')).orgId;
    otherOrgId = (await createOrg(runtime, asUser('outsider'), 'Org khác')).orgId;
    await sqlAdmin(`INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'member')`, [orgId, users.admin, users.recorder, users.attendee]);
  }, 300_000);

  afterAll(async () => {
    for (const pool of pools) await pool.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });


  const setPlace = (meetingId: string, text: string | null) => sqlAdmin(`UPDATE ludy_meetings.meeting SET place = $2 WHERE id = $1`, [meetingId, text]);
  const placeOf = async (meetingId: string) => (await sqlAdmin<{ place: string | null }>(`SELECT place FROM ludy_meetings.meeting WHERE id = $1`, [meetingId])).rows[0]?.place ?? null;
  const placeRows = (r: PersonalDataResult) => r.matches.filter((m) => m.column === 'ludy_meetings.meeting.place').length;

  it('lists a place where the actor reads the meeting, counts the rest per recorder for the owner, and redacts a place by the rule of a title', async () => {
    // Readable by the owner: a meeting shared with the org and the owner's own meeting. A clean place and a meeting with no place stay as they are.
    const shared = await meeting('recorder', 'Họp chung nơi', 'org');
    await setPlace(shared, `Phòng của ${EMAIL}, 12 Nguyễn Huệ`);
    const own = await meeting('owner', 'Họp của chủ nơi', 'attendees');
    await setPlace(own, `Nhà ${EMAIL}`);
    const clean = await meeting('recorder', 'Họp nơi sạch', 'org');
    await setPlace(clean, 'Phòng họp tầng 3, 12 Nguyễn Huệ');
    const none = await meeting('recorder', 'Họp không nơi', 'org');
    // Not readable by the owner: an attendees-only meeting of the recorder. Another org holds the value too.
    const hidden = await meeting('recorder', 'Họp kín nơi', 'attendees', ['attendee']);
    await setPlace(hidden, `Kín ${EMAIL}`);
    const foreign = await meeting('outsider', 'Họp org khác nơi', 'attendees', [], otherOrgId);
    await setPlace(foreign, `Của org khác ${EMAIL}`);

    // The finder: the owner reads two places (shared, own); the hidden one is counted per recorder as a title and never shown; an admin reads the org-shared one.
    const owner = await find('owner');
    expect(placeRows(owner)).toBe(2);
    expect(owner.meetingText).toEqual([{ recorderUserId: users.recorder, meetings: 1, lines: 0, results: 0, items: 0, titles: 1 }]);
    const answer = JSON.stringify(owner);
    expect(answer).not.toContain('Kín ');
    expect(answer).not.toContain('Của org khác');
    expect(placeRows(await find('admin'))).toBe(1);
    await expect(find('recorder')).rejects.toMatchObject({ code: 'FORBIDDEN' });

    // The erasure: what the owner reads is redacted at once; the hidden place and the other org's stay; a clean place and a missing one are untouched.
    const erased = await erase();
    expect(await placeOf(shared)).toBe(`Phòng của ${MARK}, 12 Nguyễn Huệ`);
    expect(await placeOf(own)).toBe(`Nhà ${MARK}`);
    expect(await placeOf(hidden)).toBe(`Kín ${EMAIL}`);
    expect(await placeOf(foreign)).toBe(`Của org khác ${EMAIL}`);
    expect(await placeOf(clean)).toBe('Phòng họp tầng 3, 12 Nguyễn Huệ');
    expect(await placeOf(none)).toBeNull();
    // The places count with the titles, and the one the owner could not read is kept.
    expect(erasedRows(erased, 'ludy_meetings.meeting.title')).toBe(2);
    expect(erased.kept.find((k) => k.column === 'ludy_meetings.text')?.rows).toBeGreaterThanOrEqual(1);
    // A second run changes nothing more, and the places are no longer found (but the hidden one is counted).
    expect(erasedRows(await erase(), 'ludy_meetings.meeting.title')).toBe(0);
    expect(placeRows(await find('owner'))).toBe(0);
  });

  it('names the recorder of a place the owner cannot read in the notice, and redacts that place only after the notice has stood for 24 hours at that text', async () => {
    const value = 'noi.kin.hai@khach.example';
    const hidden = await meeting('recorder', 'Họp kín nơi hai', 'attendees', ['attendee']);
    await setPlace(hidden, `Kín ${value}`);
    // No notice: kept.
    expect(erasedRows(await erase(value), 'ludy_meetings.meeting.title')).toBe(0);
    expect(await placeOf(hidden)).toBe(`Kín ${value}`);
    // The notice lists the meeting (a place is enough) and names the recorder, with a count and no text.
    const notice = await notify(value);
    expect(notice.authors).toEqual([{ authorUserId: users.recorder, notes: 0, todos: 0, meetings: 1 }]);
    expect(JSON.stringify(notice)).not.toContain('Kín ');
    const event = (await sqlAdmin<{ event: string }>(`SELECT detail ->> 'event' AS event FROM ludy_kernel.audit_event WHERE org_id = $1 AND command = 'kernel.personal_data.notify' ORDER BY id DESC LIMIT 1`, [orgId])).rows[0]?.event as string;
    const age = () =>
      admin(async (c) => {
        await c.query('BEGIN');
        await c.query('SET LOCAL session_replication_role = replica');
        await c.query(`UPDATE ludy_kernel.audit_event SET occurred_at = occurred_at - interval '25 hours' WHERE org_id = $1 AND command = 'kernel.personal_data.notify'`, [orgId]);
        await c.query('COMMIT');
      });
    await age();
    await sqlAdmin(`INSERT INTO ludy_kernel.notification (org_id, user_id, kind, dedupe_key, created_at) VALUES ($1, $2, 'kernel.personal_data_notice', $3, now() - interval '25 hours')`, [orgId, users.recorder, `personal_data_notice:${event}`]);
    // A place changed after the notice moves the stamp: the notice no longer covers the meeting, so it is kept.
    await setPlace(hidden, `Kín ${value} tầng 5`);
    expect(erasedRows(await erase(value), 'ludy_meetings.meeting.title')).toBe(0);
    expect(await placeOf(hidden)).toBe(`Kín ${value} tầng 5`);
    // Back at the text the notice saw: redacted.
    await setPlace(hidden, `Kín ${value}`);
    const done = await erase(value);
    expect(erasedRows(done, 'ludy_meetings.meeting.title')).toBe(1);
    expect(await placeOf(hidden)).toBe(`Kín ${MARK}`);
  });
});

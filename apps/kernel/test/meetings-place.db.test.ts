// SPDX-License-Identifier: AGPL-3.0-only
// The place of a meeting on a real database (#5013, refs #3162): only the recorder sets it (a reader, an outsider and an owner who is no recorder are refused), it is cleaned and bounded like a
// title, the audit row names the meeting and never the place, readers read it where they read the title (the meeting's own read), an org-shared meeting's export carries it, and the database
// refuses a place with a line break or past 200 characters whatever wrote it.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import { Runtime } from '@ludy/kernel-runtime';
import { meetingsCommands, meetingsQueries } from '@ludy/mod-meetings';
import { TEST_MANIFESTS } from './invariant/fixtures/manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const SYSTEM = { type: 'system' as const, component: 'test.meeting-place' };

suite("the place of a meeting (#5013)", () => {
  const dbName = `ludy_test_meeting_place_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  const pools: pg.Pool[] = [];
  let orgId = '';
  let runtime: Runtime;
  let worker: Runtime;
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
  async function seedMeeting(recorder: string, visibility: 'attendees' | 'org', readers: string[] = ['reader']): Promise<string> {
    const meetingId = randomUUID();
    await sqlAdmin(
      `INSERT INTO ludy_meetings.meeting (org_id, id, title, language, started_at, ended_at, length_seconds, recorder_user_id, visibility, status, consent_method, consent_confirmed_by, consent_confirmed_at, consent_notice_version, audio_retention_date, text_retention_date)
       VALUES ($1, $2, 'Họp tuần', 'vi', '2026-11-10T03:00:00Z', '2026-11-10T04:00:00Z', 3600, $3, $4, 'ready', 'told_at_start', $3, now(), '1.0', current_date + 30, current_date + 365)`,
      [orgId, meetingId, users[recorder], visibility],
    );
    if (visibility === 'attendees') for (const reader of readers) await sqlAdmin(`INSERT INTO ludy_meetings.meeting_reader (org_id, id, meeting_id, user_id) VALUES ($1, $2, $3, $4)`, [orgId, randomUUID(), meetingId, users[reader]]);
    return meetingId;
  }
  const placeOf = (meetingId: string) => sqlAdmin<{ place: string | null }>('SELECT place FROM ludy_meetings.meeting WHERE org_id = $1 AND id = $2', [orgId, meetingId]).then((r) => r.rows[0]?.place);

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
    appUrl = login('ludy_app', 'test-app-pw');
    const appPool = createPool({ connectionString: appUrl, max: 4 });
    const workerPool = createPool({ connectionString: login('ludy_worker', 'test-worker-pw'), max: 4 });
    pools.push(appPool, workerPool);
    const registry = { commands: [...kernelCommands, ...meetingsCommands], queries: [...kernelQueries({ inboundDomain: null }), ...meetingsQueries] };
    runtime = new Runtime(createDb(appPool), { manifests: TEST_MANIFESTS }).register(registry);
    worker = new Runtime(createDb(workerPool), { manifests: TEST_MANIFESTS }).register(registry);
    for (const key of ['owner', 'recorder', 'reader', 'other', 'stranger']) users[key] = await upsertIdentity(createDb(appPool), { issuer: 'place', subject: key, email: `${key}@place.test`, name: null });
    orgId = (await createOrg(runtime, asUser('owner'), 'Công ty Địa điểm')).orgId;
    await sqlAdmin(`INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member'), ($1, $4, 'member')`, [orgId, users.recorder, users.reader, users.other]);
  }, 300_000);

  afterAll(async () => {
    for (const pool of pools) await pool.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('is set by the recorder alone: a reader, a member who is no reader, an owner who is no recorder and an outsider are refused', async () => {
    const meetingId = await seedMeeting('recorder', 'attendees');
    expect(await placeOf(meetingId)).toBeNull();
    expect(await refuses(exec('reader', 'meetings.meeting.set_place', { meetingId, place: 'Phòng họp A' }))).toBe('FORBIDDEN');
    expect(await refuses(exec('other', 'meetings.meeting.set_place', { meetingId, place: 'Phòng họp A' }))).not.toBeNull();
    expect(await refuses(exec('stranger', 'meetings.meeting.set_place', { meetingId, place: 'Phòng họp A' }))).not.toBeNull();
    // The owner of the org is no recorder: the same refusal, whatever the role.
    expect(await refuses(exec('owner', 'meetings.meeting.set_place', { meetingId, place: 'Phòng họp A' }))).not.toBeNull();
    expect(await placeOf(meetingId)).toBeNull();
    const set = await exec<{ meetingId: string; place: string | null }>('recorder', 'meetings.meeting.set_place', { meetingId, place: 'Phòng họp A' });
    expect(set).toEqual({ meetingId, place: 'Phòng họp A' });
    expect(await placeOf(meetingId)).toBe('Phòng họp A');
  });

  it('cleans the place as a title is cleaned, bounds it at 200 characters, and clears it with null or text that is empty once cleaned', async () => {
    const meetingId = await seedMeeting('recorder', 'attendees');
    const set = (place: string | null) => exec<{ meetingId: string; place: string | null }>('recorder', 'meetings.meeting.set_place', { meetingId, place });
    // Control, bidi and zero-width characters go, line breaks become spaces, spaces fold, the ends are trimmed.
    expect(await set('  Tầng‮ 3,​ 12\n Nguyễn  Huệ ')).toEqual({ meetingId, place: 'Tầng 3, 12 Nguyễn Huệ' });
    expect(await placeOf(meetingId)).toBe('Tầng 3, 12 Nguyễn Huệ');
    expect(await set('a'.repeat(200))).toEqual({ meetingId, place: 'a'.repeat(200) });
    expect(await refuses(set('a'.repeat(201)))).toBe('MEETING_PLACE_TOO_LONG');
    expect(await placeOf(meetingId)).toBe('a'.repeat(200));
    // The limit counts code points, as the database's char_length does (#5043): 200 emoji (400 UTF-16 units) are stored and read back, 201 are refused.
    expect(await set('😀'.repeat(200))).toEqual({ meetingId, place: '😀'.repeat(200) });
    expect(await placeOf(meetingId)).toBe('😀'.repeat(200));
    expect(await refuses(set('😀'.repeat(201)))).toBe('MEETING_PLACE_TOO_LONG');
    expect(await placeOf(meetingId)).toBe('😀'.repeat(200));
    expect(await set('​ ‮')).toEqual({ meetingId, place: null });
    expect(await placeOf(meetingId)).toBeNull();
    await set('Quán cà phê');
    expect(await set(null)).toEqual({ meetingId, place: null });
    expect(await placeOf(meetingId)).toBeNull();
  });

  it('is read where the title is read: the recorder and the readers of the meeting see it, an outsider reads nothing', async () => {
    const meetingId = await seedMeeting('recorder', 'attendees');
    await exec('recorder', 'meetings.meeting.set_place', { meetingId, place: 'Văn phòng Đà Nẵng' });
    expect(await query<{ place: string | null; title: string }>('recorder', 'meetings.meeting.get', { meetingId })).toMatchObject({ title: 'Họp tuần', place: 'Văn phòng Đà Nẵng' });
    expect(await query<{ place: string | null }>('reader', 'meetings.meeting.get', { meetingId })).toMatchObject({ place: 'Văn phòng Đà Nẵng' });
    expect(await refuses(query('other', 'meetings.meeting.get', { meetingId }))).not.toBeNull();
    expect(await refuses(query('stranger', 'meetings.meeting.get', { meetingId }))).not.toBeNull();
    // A meeting with no place reads null, not an empty string.
    const bare = await seedMeeting('recorder', 'attendees');
    expect(await query<{ place: string | null }>('recorder', 'meetings.meeting.get', { meetingId: bare })).toMatchObject({ place: null });
  });

  it('audits the meeting and never the place, and leaves nothing of it in a notice or a mail', async () => {
    const meetingId = await seedMeeting('recorder', 'org');
    const SECRET = `Địa-điểm-riêng-${randomUUID()}`;
    await exec('recorder', 'meetings.meeting.set_place', { meetingId, place: SECRET });
    await exec('recorder', 'meetings.meeting.set_place', { meetingId, place: null });
    const audit = await sqlAdmin<{ detail: unknown }>(`SELECT detail FROM ludy_kernel.audit_event WHERE org_id = $1 AND command = 'meetings.meeting.set_place'`, [orgId]);
    expect(audit.rows.length).toBeGreaterThanOrEqual(2);
    const detail = JSON.stringify(audit.rows.map((r) => r.detail));
    expect(detail).toContain(meetingId);
    expect(detail).not.toContain(SECRET);
    // The refused attempts are audited with their code, still without the place.
    await refuses(exec('reader', 'meetings.meeting.set_place', { meetingId, place: SECRET }));
    const after = JSON.stringify((await sqlAdmin<{ detail: unknown }>(`SELECT detail FROM ludy_kernel.audit_event WHERE org_id = $1 AND command = 'meetings.meeting.set_place'`, [orgId])).rows.map((r) => r.detail));
    expect(after).not.toContain(SECRET);
    // Nothing else stored holds it: the outbox, the notices and the mail queue.
    await exec('recorder', 'meetings.meeting.set_place', { meetingId, place: SECRET });
    for (const table of ['ludy_kernel.outbox_event', 'ludy_kernel.notification', 'ludy_kernel.mail_message']) {
      const rows = await sqlAdmin<{ n: string }>(`SELECT count(*)::text AS n FROM ${table} t WHERE t.org_id = $1 AND to_jsonb(t)::text LIKE '%' || $2 || '%'`, [orgId, SECRET]);
      expect(rows.rows[0]?.n, table).toBe('0');
    }
  });

  it('is refused by the database when it has a line break, is empty or runs past 200 characters, whatever wrote it', async () => {
    const meetingId = await seedMeeting('recorder', 'attendees');
    for (const bad of ['một\ndòng', 'một\rdòng', '', 'a'.repeat(201)]) {
      await expect(sqlAdmin('UPDATE ludy_meetings.meeting SET place = $3 WHERE org_id = $1 AND id = $2', [orgId, meetingId, bad]), JSON.stringify(bad.slice(0, 8))).rejects.toThrow(/meeting_place_check/);
    }
    expect(await placeOf(meetingId)).toBeNull();
    await sqlAdmin('UPDATE ludy_meetings.meeting SET place = $3 WHERE org_id = $1 AND id = $2', [orgId, meetingId, 'a'.repeat(200)]);
    expect(await placeOf(meetingId)).toBe('a'.repeat(200));
  });

  // The org export (#2650): the meetings shared with the whole org leave with their whole row (the export function returns the meeting's row type), the place included; an attendees-only meeting stays out as before.
  it("goes with an org-shared meeting's row into the org export, and an attendees-only meeting stays out", async () => {
    const shared = await seedMeeting('recorder', 'org');
    const private_ = await seedMeeting('recorder', 'attendees');
    const PLACE = `Phòng-xuất-${randomUUID()}`;
    await exec('recorder', 'meetings.meeting.set_place', { meetingId: shared, place: PLACE });
    await exec('recorder', 'meetings.meeting.set_place', { meetingId: private_, place: 'Phòng riêng' });
    const lines: string[] = [];
    await worker.stream('kernel.org.export.snapshot', { table: 'meetings.meeting' }, { actor: SYSTEM, orgId }, async (raw) => {
      lines.push(...(raw as { lines: string[] }).lines);
    });
    const rows = lines.map((l) => JSON.parse(l) as { id: string; place?: string | null });
    expect(rows.find((r) => r.id === shared)?.place).toBe(PLACE);
    expect(rows.map((r) => r.id)).not.toContain(private_);
  });

  it('is deleted with the meeting row', async () => {
    const meetingId = await seedMeeting('recorder', 'attendees');
    await exec('recorder', 'meetings.meeting.set_place', { meetingId, place: 'Phòng sẽ bị xóa' });
    await exec('recorder', 'meetings.meeting.delete', { meetingId });
    const left = await sqlAdmin<{ n: string }>('SELECT count(*)::text AS n FROM ludy_meetings.meeting WHERE org_id = $1 AND id = $2', [orgId, meetingId]);
    expect(left.rows[0]?.n).toBe('0');
  });
});

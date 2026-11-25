// SPDX-License-Identifier: AGPL-3.0-only
// Meeting labels are personal data (#4964, review follow-up of #4955), on a real database through kernel.personal_data.find, notify and erase: a label that holds a person's value is listed where the
// actor reads the meeting and counted per recorder where the owner cannot; the erasure redacts it by the rule of a meeting title (at once where the owner reads it, after a notice and 24 hours where not),
// and drops the later row instead of failing when the redaction would leave two labels alike on one meeting (the unique index folds the case).
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

suite('meeting labels in the personal-data finder and the erasure (#4964)', () => {
  const dbName = `ludy_test_meetings_label_erase_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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
  const textOf = async (table: string, id: string, column: string) => (await sqlAdmin<{ v: string }>(`SELECT ${column}::text AS v FROM ludy_meetings.${table} WHERE id = $1`, [id])).rows[0]?.v as string;
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
    for (const key of ['owner', 'admin', 'recorder', 'attendee', 'outsider']) users[key] = await upsertIdentity(createDb(pool), { issuer: 'meetings-label-erase', subject: key, email: `${key}@meetings-label-erase.test`, name: null });
    orgId = (await createOrg(runtime, asUser('owner'), 'Nhãn trong họp')).orgId;
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


  const label = (meetingId: string, text: string, by = 'recorder', org = orgId) =>
    sqlAdmin<{ id: string }>(`INSERT INTO ludy_meetings.meeting_label (org_id, meeting_id, label, created_by) VALUES ($1, $2, $3, $4) RETURNING id`, [org, meetingId, text, users[by]]).then((r) => r.rows[0]?.id as string);
  const labelsOf = async (meetingId: string) => (await sqlAdmin<{ label: string }>(`SELECT label FROM ludy_meetings.meeting_label WHERE meeting_id = $1 ORDER BY label`, [meetingId])).rows.map((r) => r.label);
  const labelRows = (r: PersonalDataResult) => r.matches.filter((m) => m.column === 'ludy_meetings.meeting_label.label').length;

  it('lists a label where the actor reads the meeting, counts the rest per recorder for the owner, and redacts or drops a label by the rule of a title', async () => {
    // Readable by the owner: a meeting shared with the org, the owner's own meeting, and a meeting whose labels would collide once redacted.
    const shared = await meeting('recorder', 'Họp chung nhãn', 'org');
    await label(shared, `Khách ${EMAIL}`);
    await label(shared, 'Họp tuần');
    const dup = await meeting('recorder', 'Họp nhãn trùng', 'org');
    await label(dup, `Gửi ${EMAIL}`);
    await label(dup, `Gửi ${MARK}`);
    const own = await meeting('owner', 'Họp của chủ nhãn', 'attendees');
    await label(own, `Chủ ${EMAIL}`, 'owner');
    // Not readable by the owner: an attendees-only meeting of the recorder. Another org holds the value too.
    const hidden = await meeting('recorder', 'Họp kín nhãn', 'attendees', ['attendee']);
    await label(hidden, `Kín ${EMAIL}`);
    const foreign = await meeting('outsider', 'Họp org khác nhãn', 'attendees', [], otherOrgId);
    await label(foreign, `Của org khác ${EMAIL}`, 'outsider', otherOrgId);

    // The finder: the owner reads three labels (shared, collision meeting, own); the hidden one is counted per recorder as a title and never shown; an admin reads the two org-shared ones.
    const owner = await find('owner');
    expect(labelRows(owner)).toBe(3);
    expect(owner.meetingText).toEqual([{ recorderUserId: users.recorder, meetings: 1, lines: 0, results: 0, items: 0, titles: 1 }]);
    const answer = JSON.stringify(owner);
    expect(answer).not.toContain('Kín ');
    expect(answer).not.toContain('Của org khác');
    expect(labelRows(await find('admin'))).toBe(2);
    await expect(find('recorder')).rejects.toMatchObject({ code: 'FORBIDDEN' });

    // The erasure: what the owner reads is redacted at once; a label that would equal another of its meeting is dropped; the hidden and the other org's stay.
    const erased = await erase();
    expect(await labelsOf(shared)).toEqual([`Khách ${MARK}`, 'Họp tuần'].sort());
    expect(await labelsOf(dup)).toEqual([`Gửi ${MARK}`]);
    expect(await labelsOf(own)).toEqual([`Chủ ${MARK}`]);
    expect(await labelsOf(hidden)).toEqual([`Kín ${EMAIL}`]);
    expect(await labelsOf(foreign)).toEqual([`Của org khác ${EMAIL}`]);
    // The labels count with the titles (a redacted one and a dropped one alike).
    expect(erasedRows(erased, 'ludy_meetings.meeting.title')).toBe(3);
    expect(erased.kept.find((k) => k.column === 'ludy_meetings.text')?.rows).toBeGreaterThanOrEqual(1);
    // A second run changes nothing more, and the labels are no longer found (but the hidden one).
    expect(erasedRows(await erase(), 'ludy_meetings.meeting.title')).toBe(0);
    expect(labelRows(await find('owner'))).toBe(0);
  });

  it('names the recorder of a label the owner cannot read in the notice, and redacts that label only after the notice has stood for 24 hours at that text', async () => {
    const value = 'nhan.kin.hai@khach.example';
    const hidden = await meeting('recorder', 'Họp kín nhãn hai', 'attendees', ['attendee']);
    const kin = await label(hidden, `Kín ${value}`);
    // No notice: kept.
    expect(erasedRows(await erase(value), 'ludy_meetings.meeting.title')).toBe(0);
    expect(await labelsOf(hidden)).toEqual([`Kín ${value}`]);
    // The notice lists the meeting (a label is enough) and names the recorder, with a count and no text.
    const notice = await notify(value);
    expect(notice.authors).toEqual([{ authorUserId: users.recorder, notes: 0, todos: 0, meetings: 1 }]);
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
    // A label added after the notice moves the stamp: the notice no longer covers the meeting, so it is kept.
    const extra = await label(hidden, 'Nhãn thêm sau thông báo');
    expect(erasedRows(await erase(value), 'ludy_meetings.meeting.title')).toBe(0);
    expect(await labelsOf(hidden)).toEqual([`Kín ${value}`, 'Nhãn thêm sau thông báo'].sort());
    await sqlAdmin(`DELETE FROM ludy_meetings.meeting_label WHERE id = $1`, [extra]);
    // Back at the text the notice saw: redacted.
    const done = await erase(value);
    expect(erasedRows(done, 'ludy_meetings.meeting.title')).toBe(1);
    expect(await textOf('meeting_label', kin, 'label')).toBe(`Kín ${MARK}`);
  });
});

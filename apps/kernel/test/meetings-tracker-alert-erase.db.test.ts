// SPDX-License-Identifier: AGPL-3.0-only
// The tracked-word alert mail goes with its meeting like the follow-up mail does (#5012, #3016, ADR-0047 point 7) on PostgreSQL 17: the recorder's delete, the text retention purge, the archive
// replay and the personal-data erasure each drop the payload and the subject of the alert mails of that meeting (the row and its status stay; another meeting's alert mails and a mail of another
// source with the same id are untouched), a CANARY in the payload is gone after each path, and the follow-up mail behaves as before.
// Set LUDY_TEST_ADMIN_URL (or CROVE_TEST_ADMIN_URL) to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import type { FollowupDraft, PersonalDataErasure } from '@ludy/kernel-contract';
import { Runtime } from '@ludy/kernel-runtime';
import { meetingsCommands, meetingsQueries } from '@ludy/mod-meetings';
import { TEST_MANIFESTS } from './invariant/fixtures/manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const SYSTEM = { type: 'system' as const, component: 'test.tracker-alert-erase' };

suite('tracker alert mails and the erasure of a meeting (#5012)', () => {
  const dbName = `ludy_test_tracker_alert_erase_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  const pools: pg.Pool[] = [];
  let runtime: Runtime;
  let worker: Runtime;
  let orgId = '';
  const users: Record<string, string> = {};
  const asUser = (who: string) => ({ type: 'user' as const, userId: users[who] as string, aal: 'aal1' as const });
  const exec = <O = unknown>(who: string, name: string, input: unknown, idempotencyKey?: string) => runtime.execute<O>(name, input, { actor: asUser(who), orgId, ...(idempotencyKey ? { idempotencyKey } : {}) });
  const query = <O = unknown>(who: string, name: string, input: unknown) => runtime.query<O>(name, input, { actor: asUser(who), orgId });

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

  // A meeting of the recorder, with a published summary when one is given (the erasure redacts a mention in it).
  async function seedMeeting(opts: { recorder?: string; summary?: string } = {}): Promise<string> {
    const recorder = opts.recorder ?? 'recorder';
    const meetingId = randomUUID();
    await sqlAdmin(
      `INSERT INTO ludy_meetings.meeting (org_id, id, title, language, started_at, ended_at, length_seconds, recorder_user_id, visibility, status, consent_method, consent_confirmed_by, consent_confirmed_at, consent_notice_version, audio_retention_date, text_retention_date)
       VALUES ($1, $2, 'Họp tuần', 'vi', now(), now() + interval '30 minutes', 1800, $3, 'attendees', 'ready', 'told_at_start', $3, now(), '1.0', current_date + 30, current_date + 365)`,
      [orgId, meetingId, users[recorder]],
    );
    await sqlAdmin('INSERT INTO ludy_meetings.meeting_reader (org_id, id, meeting_id, user_id) VALUES ($1, $2, $3, $4)', [orgId, randomUUID(), meetingId, users.attendee]);
    if (opts.summary !== undefined) {
      await exec(recorder, 'meetings.summary.save', { meetingId, summary: opts.summary, decisions: ['Giữ giá cũ'] });
      await exec(recorder, 'meetings.result.publish', { meetingId, confirmed: true });
    }
    return meetingId;
  }
  // The tracked-word alert mail the alert job queues for a member: a count of the words found, the meeting's link and the org's name, which is where the CANARY sits.
  const CANARY = `Cong-ty-bi-mat-${randomUUID()}`;
  async function seedAlert(meetingId: string): Promise<string> {
    return (await sqlAdmin<{ id: string }>(
      "INSERT INTO ludy_kernel.mail_message (org_id, stream, source, source_id, template_key, to_address, to_hash, subject, payload, message_id_header, status) VALUES ($1, 'transactional', 'meetings.tracker_alert', $2, 'meetings.tracker_alert', 'attendee@erase.test', repeat('d', 64), $3, $4::jsonb, $5, 'queued') RETURNING id",
      [orgId, meetingId, `Tu khoa theo doi ${CANARY}`, JSON.stringify({ lang: 'vi', org: CANARY, words: 7, path: `/o/x/meetings/${meetingId}` }), `<alert-${randomUUID()}@y.test>`],
    )).rows[0]!.id;
  }
  // A follow-up mail sent for the meeting (it needs a published summary), to show the follow-up mail's own behaviour does not change.
  async function sendFollowup(meetingId: string, recorder = 'recorder'): Promise<void> {
    const draft = await query<FollowupDraft>(recorder, 'meetings.followup.draft', { meetingId });
    await exec(
      recorder,
      'meetings.followup.send',
      { meetingId, factsKey: draft.factsKey, subject: 'Tóm tắt', greeting: 'Xin chào,', lead: 'Cảm ơn mọi người.', closing: 'Cảm ơn.', recipients: ['attendee@erase.test'], confirmedOutsiders: [], confirmRepeat: false, fromVy: false, reviewed: false },
      randomUUID(),
    );
  }
  const mailsOf = (source: string, meetingId: string) =>
    sqlAdmin<{ id: string; payload: unknown; status: string; to_address: string | null; subject: string | null }>('SELECT id, payload, status, to_address, subject FROM ludy_kernel.mail_message WHERE org_id = $1 AND source = $2 AND source_id = $3', [orgId, source, meetingId]).then((r) => r.rows);
  const alertMails = (meetingId: string) => mailsOf('meetings.tracker_alert', meetingId);
  const audit = (command: string, meetingId: string) =>
    sqlAdmin<{ detail: Record<string, unknown> }>('SELECT detail FROM ludy_kernel.audit_event WHERE org_id = $1 AND command = $2 AND target_id = $3', [orgId, command, meetingId]).then((r) => r.rows);

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
    const registry = { commands: [...kernelCommands, ...meetingsCommands], queries: [...kernelQueries({ inboundDomain: null }), ...meetingsQueries] };
    runtime = new Runtime(createDb(appPool), { manifests: TEST_MANIFESTS }).register(registry);
    worker = new Runtime(createDb(workerPool), { manifests: TEST_MANIFESTS }).register(registry);
    for (const key of ['owner', 'recorder', 'attendee']) {
      users[key] = await upsertIdentity(createDb(appPool), { issuer: 'erase', subject: key, email: `${key}@erase.test`, name: null });
    }
    orgId = (await createOrg(runtime, asUser('owner'), 'Công ty Xóa')).orgId;
    await sqlAdmin("INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member')", [orgId, users.recorder, users.attendee]);
  }, 300_000);

  afterAll(async () => {
    await Promise.all(pools.map((p) => p.end()));
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  const gone = (rows: Array<{ payload: unknown; subject: string | null }>) => rows.every((r) => r.payload === null && r.subject === null);

  it('the recorder\'s delete drops the alert mails of that meeting only: payload and subject go, the row and its status stay', async () => {
    const dead = await seedMeeting();
    const alive = await seedMeeting();
    await seedAlert(dead);
    await seedAlert(alive);
    // Another source with the same id is not touched.
    const other = (await sqlAdmin<{ id: string }>(
      "INSERT INTO ludy_kernel.mail_message (org_id, stream, source, source_id, template_key, to_address, to_hash, subject, payload, message_id_header, status) VALUES ($1, 'transactional', 'finance.payment_reminder.notice1', $2, 'x.y', 'a@b.test', repeat('a', 64), 's', '{\"keep\":true}', $3, 'queued') RETURNING id",
      [orgId, dead, `<other-${randomUUID()}@y.test>`],
    )).rows[0]!.id;
    expect(JSON.stringify((await alertMails(dead))[0]?.payload)).toContain(CANARY);
    await exec('recorder', 'meetings.meeting.delete', { meetingId: dead });
    const after = await alertMails(dead);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ payload: null, subject: null, status: 'queued', to_address: 'attendee@erase.test' });
    expect(JSON.stringify(after)).not.toContain(CANARY);
    expect(JSON.stringify((await alertMails(alive))[0]?.payload)).toContain(CANARY);
    expect((await sqlAdmin<{ payload: unknown }>('SELECT payload FROM ludy_kernel.mail_message WHERE org_id = $1 AND id = $2', [orgId, other])).rows[0]?.payload).toEqual({ keep: true });
    // The audit row holds a count, never the text.
    const rows = await audit('meetings.meeting.delete', dead);
    expect(rows[0]?.detail).toMatchObject({ meetingId: dead, mailPayloads: 1 });
    expect(JSON.stringify(rows[0]?.detail)).not.toContain(CANARY);
  });

  it('the owner\'s compliance delete does the same', async () => {
    const m = await seedMeeting();
    await seedAlert(m);
    await runtime.execute('meetings.meeting.owner_delete', { meetingId: m }, { actor: { ...asUser('owner'), aal: 'aal2' as const, mfaAt: Math.floor(Date.now() / 1000) }, orgId });
    expect(gone(await alertMails(m))).toBe(true);
  });

  it('the text retention purge drops them when the meeting is due, and keeps them when it is not', async () => {
    const early = await seedMeeting();
    const due = await seedMeeting();
    await seedAlert(early);
    await seedAlert(due);
    expect(await worker.execute('meetings.retention.shred', { meetingId: early, kind: 'text' }, { actor: SYSTEM, orgId })).toMatchObject({ applied: false });
    expect(JSON.stringify(await alertMails(early))).toContain(CANARY);
    await sqlAdmin('UPDATE ludy_meetings.meeting SET text_retention_date = current_date - 1 WHERE org_id = $1 AND id = $2', [orgId, due]);
    expect(await worker.execute('meetings.retention.shred', { meetingId: due, kind: 'text' }, { actor: SYSTEM, orgId })).toMatchObject({ applied: true });
    const after = await alertMails(due);
    expect(gone(after)).toBe(true);
    expect(JSON.stringify(after)).not.toContain(CANARY);
    expect((await audit('meetings.retention.shred', due))[0]?.detail).toMatchObject({ applied: true, mailPayloads: 1 });
    expect(JSON.stringify(await alertMails(early))).toContain(CANARY);
  });

  it('the archive replay of a shred drops them too', async () => {
    const m = await seedMeeting();
    await seedAlert(m);
    expect(await worker.execute('meetings.shred.replay', { meetingId: m }, { actor: SYSTEM, orgId })).toMatchObject({ deleted: true });
    const after = await alertMails(m);
    expect(gone(after)).toBe(true);
    expect(JSON.stringify(after)).not.toContain(CANARY);
    // Again: nothing left, nothing changes.
    expect(await worker.execute('meetings.shred.replay', { meetingId: m }, { actor: SYSTEM, orgId })).toMatchObject({ deleted: false });
  });

  it('a delete drops the follow-up mail and the alert mail of the meeting together, and the follow-up mail behaves as before', async () => {
    const m = await seedMeeting({ summary: 'Chốt báo giá tuần này.' });
    await sendFollowup(m);
    await seedAlert(m);
    expect((await mailsOf('meetings.followup', m))[0]?.payload).not.toBeNull();
    await exec('recorder', 'meetings.meeting.delete', { meetingId: m });
    expect((await mailsOf('meetings.followup', m))[0]).toMatchObject({ payload: null, subject: null, status: 'queued' });
    expect(gone(await alertMails(m))).toBe(true);
    expect((await audit('meetings.meeting.delete', m))[0]?.detail).toMatchObject({ meetingId: m, mailPayloads: 2 });
  });

  // The erasure of a mention (#3020): kernel.personal_data.erase redacts the meeting's rows; the alert mails of a meeting whose rows it changed go with them, counted apart from the follow-up mails.
  describe('kernel.personal_data.erase', () => {
    const MENTION = 'khach.hang@erase.test';
    const asMfa = (who: string) => ({ type: 'user' as const, userId: users[who] as string, aal: 'aal2' as const, sessionId: randomUUID(), mfaAt: Math.floor(Date.now() / 1000) });
    const erase = (value = MENTION) => runtime.execute<PersonalDataErasure>('kernel.personal_data.erase', { value }, { actor: asMfa('owner'), orgId, idempotencyKey: randomUUID() });
    const lastAudit = () =>
      sqlAdmin<{ detail: Record<string, unknown> }>("SELECT detail FROM ludy_kernel.audit_event WHERE org_id = $1 AND command = 'kernel.personal_data.erase' ORDER BY id DESC LIMIT 1", [orgId]).then((r) => r.rows[0]?.detail);

    it('drops the alert mails of a meeting whose rows it changed, keeps those of another meeting, and counts them apart from the follow-up mails', async () => {
      // The owner records these meetings, so the erasure may redact them at once.
      const touched = await seedMeeting({ recorder: 'owner', summary: `Gửi báo giá cho ${MENTION} trước thứ sáu.` });
      const untouched = await seedMeeting({ recorder: 'owner', summary: 'Chốt kế hoạch quý.' });
      await seedAlert(touched);
      await seedAlert(untouched);
      const result = await erase();
      expect(result.erased.find((e) => e.column === 'ludy_meetings.meeting_result.summary')?.rows).toBe(1);
      const after = await alertMails(touched);
      expect(after[0]).toMatchObject({ payload: null, subject: null, status: 'queued', to_address: 'attendee@erase.test' });
      expect(JSON.stringify(after)).not.toContain(CANARY);
      expect(JSON.stringify(await alertMails(untouched))).toContain(CANARY);
      const detail = await lastAudit();
      expect(detail).toMatchObject({ follow_up_mails: 0, tracker_alert_mails: 1 });
      expect(JSON.stringify(detail)).not.toContain(CANARY);
      expect(JSON.stringify(detail)).not.toContain(MENTION);
    });

    it('drops nothing when the erasure changed no row of the meeting', async () => {
      const hidden = await seedMeeting({ recorder: 'recorder', summary: 'Nhắc nguoi.khac@erase.test ký hợp đồng.' });
      await seedAlert(hidden);
      await erase('nguoi.khac@erase.test');
      expect(JSON.stringify(await alertMails(hidden))).toContain(CANARY);
      expect(await lastAudit()).toMatchObject({ tracker_alert_mails: 0 });
    });

    it('leaves the follow-up mail of the same meeting counted as before', async () => {
      const m = await seedMeeting({ recorder: 'owner', summary: `Gửi ${MENTION} báo giá.` });
      await sendFollowup(m, 'owner');
      await seedAlert(m);
      await erase();
      expect((await mailsOf('meetings.followup', m))[0]).toMatchObject({ payload: null, subject: null });
      expect(gone(await alertMails(m))).toBe(true);
      expect(await lastAudit()).toMatchObject({ follow_up_mails: 1, tracker_alert_mails: 1 });
    });
  });
});

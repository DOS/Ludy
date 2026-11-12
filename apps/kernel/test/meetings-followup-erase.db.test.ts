// SPDX-License-Identifier: AGPL-3.0-only
// The copy of a meeting's text in its follow-up mails goes with the meeting (#3016, ADR-0047 point 7) on PostgreSQL 17: the recorder's delete, the owner's compliance delete, the
// text retention purge and the archive replay each drop the payload of the follow-up mails of that meeting (and nothing else: the mail row, its status and its counts stay, another
// meeting's mails and a mail of another source are untouched), a meeting not yet due keeps its mails' payloads, and the audit row holds a count only.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import type { FollowupDraft, PersonalDataErasure } from '@crove/kernel-contract';
import { Runtime } from '@crove/kernel-runtime';
import { meetingsCommands, meetingsQueries } from '@crove/mod-meetings';
import { TEST_MANIFESTS } from './invariant/fixtures/manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const SYSTEM = { type: 'system' as const, component: 'test.followup-erase' };

suite('follow-up mails and the erasure of a meeting (#3016)', () => {
  const dbName = `crove_test_followup_erase_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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

  // A meeting with a shared summary, and one follow-up mail sent for it.
  async function seedSent(opts: { recorder?: string; summary?: string; subject?: string } = {}): Promise<string> {
    const recorder = opts.recorder ?? 'recorder';
    const meetingId = randomUUID();
    await sqlAdmin(
      `INSERT INTO crove_meetings.meeting (org_id, id, title, language, started_at, ended_at, length_seconds, recorder_user_id, visibility, status, consent_method, consent_confirmed_by, consent_confirmed_at, consent_notice_version, audio_retention_date, text_retention_date)
       VALUES ($1, $2, 'Họp tuần', 'vi', now(), now() + interval '30 minutes', 1800, $3, 'attendees', 'ready', 'told_at_start', $3, now(), '1.0', current_date + 30, current_date + 365)`,
      [orgId, meetingId, users[recorder]],
    );
    await sqlAdmin('INSERT INTO crove_meetings.meeting_reader (org_id, id, meeting_id, user_id) VALUES ($1, $2, $3, $4)', [orgId, randomUUID(), meetingId, users.attendee]);
    await exec(recorder, 'meetings.summary.save', { meetingId, summary: opts.summary ?? 'Chốt báo giá tuần này.', decisions: ['Giữ giá cũ'] });
    await exec(recorder, 'meetings.result.publish', { meetingId, confirmed: true });
    const draft = await query<FollowupDraft>(recorder, 'meetings.followup.draft', { meetingId });
    await exec(
      recorder,
      'meetings.followup.send',
      { meetingId, factsKey: draft.factsKey, subject: opts.subject ?? 'Tóm tắt', greeting: 'Xin chào,', lead: 'Cảm ơn mọi người.', closing: 'Cảm ơn.', recipients: ['attendee@erase.test'], confirmedOutsiders: [], confirmRepeat: false, fromVy: false, reviewed: false },
      randomUUID(),
    );
    return meetingId;
  }
  const mail = (meetingId: string) =>
    sqlAdmin<{ payload: unknown; status: string; to_address: string | null; subject: string | null }>("SELECT payload, status, to_address, subject FROM crove_kernel.mail_message WHERE org_id = $1 AND source = 'meetings.followup' AND source_id = $2", [orgId, meetingId]).then((r) => r.rows);
  const audit = (command: string, meetingId: string) =>
    sqlAdmin<{ detail: Record<string, unknown> }>('SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = $2 AND target_id = $3', [orgId, command, meetingId]).then((r) => r.rows);

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
    const registry = { commands: [...kernelCommands, ...meetingsCommands], queries: [...kernelQueries({ inboundDomain: null }), ...meetingsQueries] };
    runtime = new Runtime(createDb(appPool), { manifests: TEST_MANIFESTS }).register(registry);
    worker = new Runtime(createDb(workerPool), { manifests: TEST_MANIFESTS }).register(registry);
    for (const key of ['owner', 'recorder', 'attendee']) {
      users[key] = await upsertIdentity(createDb(appPool), { issuer: 'erase', subject: key, email: `${key}@erase.test`, name: null });
    }
    orgId = (await createOrg(runtime, asUser('owner'), 'Công ty Xóa')).orgId;
    await sqlAdmin("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member')", [orgId, users.recorder, users.attendee]);
  }, 300_000);

  afterAll(async () => {
    await Promise.all(pools.map((p) => p.end()));
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('the recorder\'s delete drops the payload of that meeting\'s follow-up mails only, and the audit row holds a count', async () => {
    const gone = await seedSent();
    const kept = await seedSent();
    expect((await mail(gone))[0]?.payload).not.toBeNull();
    await exec('recorder', 'meetings.meeting.delete', { meetingId: gone });
    const after = await mail(gone);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ payload: null, status: 'queued' });
    expect((await mail(kept))[0]?.payload).not.toBeNull();
    const rows = await audit('meetings.meeting.delete', gone);
    expect(rows[0]?.detail).toMatchObject({ meetingId: gone, mailPayloads: 1 });
    expect(JSON.stringify(rows[0]?.detail)).not.toContain('báo giá');
  });

  it('the owner\'s compliance delete does the same', async () => {
    const gone = await seedSent();
    // An R3 command: the owner's second factor is fresh.
    await runtime.execute('meetings.meeting.owner_delete', { meetingId: gone }, { actor: { ...asUser('owner'), aal: 'aal2' as const, mfaAt: Math.floor(Date.now() / 1000) }, orgId });
    expect((await mail(gone))[0]).toMatchObject({ payload: null });
    expect((await audit('meetings.meeting.owner_delete', gone))[0]?.detail).toMatchObject({ mailPayloads: 1 });
  });

  it('the text retention purge drops it when the meeting is due, and keeps it when it is not', async () => {
    const early = await seedSent();
    const due = await seedSent();
    // Not due yet: nothing is purged and the mails keep their payload.
    expect(await worker.execute('meetings.retention.shred', { meetingId: early, kind: 'text' }, { actor: SYSTEM, orgId })).toMatchObject({ applied: false });
    expect((await mail(early))[0]?.payload).not.toBeNull();
    await sqlAdmin('UPDATE crove_meetings.meeting SET text_retention_date = current_date - 1 WHERE org_id = $1 AND id = $2', [orgId, due]);
    expect(await worker.execute('meetings.retention.shred', { meetingId: due, kind: 'text' }, { actor: SYSTEM, orgId })).toMatchObject({ applied: true });
    expect((await mail(due))[0]).toMatchObject({ payload: null });
    expect((await audit('meetings.retention.shred', due))[0]?.detail).toMatchObject({ applied: true, mailPayloads: 1 });
    expect((await mail(early))[0]?.payload).not.toBeNull();
  });

  it('the archive replay of a shred drops it too', async () => {
    const gone = await seedSent();
    expect(await worker.execute('meetings.shred.replay', { meetingId: gone }, { actor: SYSTEM, orgId })).toMatchObject({ deleted: true });
    expect((await mail(gone))[0]).toMatchObject({ payload: null });
    // Again: nothing left, nothing changes.
    expect(await worker.execute('meetings.shred.replay', { meetingId: gone }, { actor: SYSTEM, orgId })).toMatchObject({ deleted: false });
  });

  it('a send running at the same moment as a delete is not left with a mail that holds the text', async () => {
    const m = await seedSent();
    const draft = await query<FollowupDraft>('recorder', 'meetings.followup.draft', { meetingId: m });
    const send = exec('recorder', 'meetings.followup.send', { meetingId: m, factsKey: draft.factsKey, subject: 'Tóm tắt', greeting: 'Xin chào,', lead: 'Cảm ơn mọi người.', closing: 'Cảm ơn.', recipients: ['attendee@erase.test'], confirmedOutsiders: [], confirmRepeat: true, fromVy: false, reviewed: false }, randomUUID()).then(() => 'sent', (e: unknown) => (e as { code?: string }).code ?? 'ERR');
    const del = exec('recorder', 'meetings.meeting.delete', { meetingId: m }).then(() => 'deleted', (e: unknown) => (e as { code?: string }).code ?? 'ERR');
    await Promise.all([send, del]);
    // Whichever ran first, no mail of the meeting still holds the text.
    expect((await mail(m)).filter((r) => r.payload !== null)).toEqual([]);
  });

  it('leaves a mail of another source with the same id untouched', async () => {
    const m = await seedSent();
    const other = (await sqlAdmin<{ id: string }>(
      "INSERT INTO crove_kernel.mail_message (org_id, stream, source, source_id, template_key, to_address, to_hash, subject, payload, message_id_header, status) VALUES ($1, 'transactional', 'finance.payment_reminder.notice1', $2, 'x.y', 'a@b.test', repeat('a', 64), 's', '{\"keep\":true}', '<x@y.test>', 'queued') RETURNING id",
      [orgId, m],
    )).rows[0]!.id;
    await exec('recorder', 'meetings.meeting.delete', { meetingId: m });
    const kept = await sqlAdmin<{ payload: unknown }>('SELECT payload FROM crove_kernel.mail_message WHERE org_id = $1 AND id = $2', [orgId, other]);
    expect(kept.rows[0]?.payload).toEqual({ keep: true });
  });

  // The erasure of a mention (#3020, ADR-0047 point 7): kernel.personal_data.erase redacts the meeting's rows, and the copy in its follow-up mails goes with them.
  describe('kernel.personal_data.erase', () => {
    const MENTION = 'khach.hang@erase.test';
    const asMfa = (who: string) => ({ type: 'user' as const, userId: users[who] as string, aal: 'aal2' as const, sessionId: randomUUID(), mfaAt: Math.floor(Date.now() / 1000) });
    const OTHER = 'nguoi.khac@erase.test';
    const erase = (value = MENTION) => runtime.execute<PersonalDataErasure>('kernel.personal_data.erase', { value }, { actor: asMfa('owner'), orgId, idempotencyKey: randomUUID() });
    const lastAudit = () =>
      sqlAdmin<{ detail: Record<string, unknown> }>("SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'kernel.personal_data.erase' ORDER BY id DESC LIMIT 1", [orgId]).then((r) => r.rows[0]?.detail);

    it('drops the payload and the subject of the follow-up mails of a meeting whose rows it changed, and only those', async () => {
      // The owner records these meetings, so the erasure may redact them at once.
      const touched = await seedSent({ recorder: 'owner', summary: `Gửi báo giá cho ${MENTION} trước thứ sáu.`, subject: "Tóm tắt họp với anh Khách" });
      const untouched = await seedSent({ recorder: 'owner', summary: 'Chốt kế hoạch quý.' });
      const other = (await sqlAdmin<{ id: string }>(
        "INSERT INTO crove_kernel.mail_message (org_id, stream, source, source_id, template_key, to_address, to_hash, subject, payload, message_id_header, status) VALUES ($1, 'transactional', 'finance.payment_reminder.notice1', $2, 'x.y', 'a@b.test', repeat('b', 64), 's', '{\"keep\":true}', '<erase-other@y.test>', 'queued') RETURNING id",
        [orgId, touched],
      )).rows[0]!.id;
      const before = (await mail(touched))[0];
      expect(before?.payload).not.toBeNull();
      expect(before?.subject).not.toBeNull();

      const result = await erase();
      expect(result.erased.find((e) => e.column === 'crove_meetings.meeting_result.summary')?.rows).toBe(1);

      const after = await mail(touched);
      expect(after).toHaveLength(1);
      // The row, its status and its recipient stay; the two copies of the text are gone.
      expect(after[0]).toMatchObject({ payload: null, subject: null, status: 'queued', to_address: 'attendee@erase.test' });
      const left = await mail(untouched);
      expect(left[0]?.payload).not.toBeNull();
      expect(left[0]?.subject).toBe('Tóm tắt');
      expect((await sqlAdmin<{ payload: unknown }>('SELECT payload FROM crove_kernel.mail_message WHERE org_id = $1 AND id = $2', [orgId, other])).rows[0]?.payload).toEqual({ keep: true });
      // The audit row holds a count, never the text.
      const detail = await lastAudit();
      expect(detail).toMatchObject({ follow_up_mails: 1 });
      expect(JSON.stringify(detail)).not.toContain('báo giá');
      expect(JSON.stringify(detail)).not.toContain(MENTION);
    });

    it('drops nothing when the erasure changed no row of the meeting', async () => {
      // A meeting the owner cannot read (another recorder's, the owner is no reader): the mention stays there, counted, and so does the mail.
      const hidden = await seedSent({ recorder: 'recorder', summary: `Nhắc ${OTHER} ký hợp đồng.`, subject: 'Tóm tắt' });
      const result = await erase(OTHER);
      expect(result.erased.find((e) => e.column === 'crove_meetings.meeting_result.summary')).toBeUndefined();
      const kept = (await mail(hidden))[0];
      expect(kept?.payload).not.toBeNull();
      expect(kept?.subject).toBe('Tóm tắt');
      expect(await lastAudit()).toMatchObject({ follow_up_mails: 0 });
    });

    it('answers a retry and changes nothing while a send of that meeting holds the follow-up lock', async () => {
      const BUSY = 'dang.ban@erase.test';
      const busy = await seedSent({ recorder: 'owner', summary: `Gửi ${BUSY} bản ghi.` });
      const holder = new pg.Client({ connectionString: adminUrl });
      await holder.connect();
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))', [`meetings.followup:${orgId}:${busy}`]);
        await expect(erase(BUSY)).rejects.toMatchObject({ code: 'PERSONAL_DATA_BUSY' });
      } finally {
        await holder.query('ROLLBACK');
        await holder.end();
      }
      // The whole erasure rolled back: the summary still holds the value and the mail its copy.
      expect((await sqlAdmin<{ summary: string }>('SELECT summary FROM crove_meetings.meeting_result WHERE org_id = $1 AND meeting_id = $2', [orgId, busy])).rows[0]?.summary).toContain(BUSY);
      expect((await mail(busy))[0]?.payload).not.toBeNull();
      // Asked again once the lock is free, it goes through.
      await erase(BUSY);
      expect((await mail(busy))[0]).toMatchObject({ payload: null, subject: null });
    });

    // #3025: mails whose own text mentions the value are dropped whether or not the meeting's rows changed.
    describe('by the mail\'s own text (#3025)', () => {
      const LEFT = 'con.lai@erase.test';
      // The send refuses an address, a link or a figure in the subject, so a value gets into a subject only past that check (a form it does not catch): seeded as the superuser, guard set aside.
      const setSubject = (meetingId: string, subject: string) =>
        admin(async (c) => {
          await c.query('BEGIN');
          await c.query('SET LOCAL session_replication_role = replica');
          await c.query("UPDATE crove_kernel.mail_message SET subject = $3 WHERE org_id = $1 AND source = 'meetings.followup' AND source_id = $2", [orgId, meetingId, subject]);
          await c.query('COMMIT');
        });
      const deliver = async (meetingId: string) => {
        await sqlAdmin("UPDATE crove_kernel.mail_message SET status = 'sending' WHERE org_id = $1 AND source = 'meetings.followup' AND source_id = $2", [orgId, meetingId]);
        await sqlAdmin("UPDATE crove_kernel.mail_message SET status = 'sent', sent_at = now() WHERE org_id = $1 AND source = 'meetings.followup' AND source_id = $2", [orgId, meetingId]);
      };

      it('drops the mail when the recorder edited the value out of the meeting after the send, so the meeting has no hit', async () => {
        const value = 'da.sua@erase.test';
        const edited = await seedSent({ recorder: 'owner', summary: `Gửi ${value} bản chốt.`, subject: 'Tóm tắt tuần' });
        await sqlAdmin("UPDATE crove_meetings.meeting_result SET summary = 'Gửi bản chốt.' WHERE org_id = $1 AND meeting_id = $2", [orgId, edited]);
        expect((await mail(edited))[0]?.payload).not.toBeNull();
        const out = await erase(value);
        expect(out.erased.find((e) => e.column === 'crove_meetings.meeting_result.summary')).toBeUndefined();
        expect((await mail(edited))[0]).toMatchObject({ payload: null, subject: null, status: 'queued', to_address: 'attendee@erase.test' });
        expect(await lastAudit()).toMatchObject({ follow_up_mails: 1 });
      });

      // The payload is matched as its jsonb text, in which a quote and a backslash are escaped (\" and \\): the value must still be found next to them, in Vietnamese text, and a phone
      // number with the spaces and dots people write.
      it('finds the value in the payload next to quotes, backslashes and Vietnamese text, for an address and for a phone number', async () => {
        const value = 'trich.dan@erase.test';
        const quoted = await seedSent({ recorder: 'owner', summary: `Khách nói: "${value}" là địa chỉ đúng; đường dẫn C:\\thu\\${value}\\ và 'nháy đơn'.` });
        const phone = '0912345678';
        const phoned = await seedSent({ recorder: 'owner', summary: 'Gọi khách theo số 091 234 5678 hoặc 0912.345.678 sau 3 giờ chiều.' });
        // The meetings no longer mention either (the recorders edited them out), so only the mail's own text holds the value.
        await sqlAdmin("UPDATE crove_meetings.meeting_result SET summary = 'Đã sửa.' WHERE org_id = $1 AND meeting_id = ANY ($2::uuid[])", [orgId, [quoted, phoned]]);
        expect(JSON.stringify((await mail(quoted))[0]?.payload)).toContain(value);
        // The text form the database matches really holds the escapes.
        const escaped = await sqlAdmin<{ q: boolean; b: boolean }>("SELECT position(E'\\\\\"' in payload::text) > 0 AS q, position(E'\\\\\\\\' in payload::text) > 0 AS b FROM crove_kernel.mail_message WHERE org_id = $1 AND source = 'meetings.followup' AND source_id = $2", [orgId, quoted]);
        expect(escaped.rows[0]).toEqual({ q: true, b: true });
        await erase(value);
        expect((await mail(quoted))[0]).toMatchObject({ payload: null, subject: null });
        expect((await mail(phoned))[0]?.payload).not.toBeNull();
        await erase(phone);
        expect((await mail(phoned))[0]).toMatchObject({ payload: null, subject: null });
      });

      it('drops the mail when the value is only in its subject', async () => {
        const value = 'chi.tieu.de@erase.test';
        const subjectOnly = await seedSent({ recorder: 'owner', summary: 'Chốt kế hoạch quý.' });
        await setSubject(subjectOnly, `Gửi ${value}`);
        const out = await erase(value);
        expect(out.erased.filter((e) => e.column.startsWith('crove_meetings.'))).toEqual([]);
        expect((await mail(subjectOnly))[0]).toMatchObject({ payload: null, subject: null });
      });

      it('leaves every other mail alone: one without the value, another source, another org, and a mail of the same meeting that does not mention it', async () => {
        const value = 'chi.mot@erase.test';
        const clean = await seedSent({ recorder: 'owner', summary: 'Chốt kế hoạch quý.' });
        const same = await seedSent({ recorder: 'owner', summary: 'Chốt kế hoạch quý.' });
        await setSubject(same, `Gửi ${value}`);
        // A second mail of the same meeting, with text that does not mention the value.
        await sqlAdmin(
          `INSERT INTO crove_kernel.mail_message (org_id, stream, source, source_id, template_key, to_address, to_hash, subject, payload, message_id_header, status)
           SELECT org_id, stream, source, source_id, template_key, 'khac@erase.test', repeat('c', 64), 'Không có giá trị', '{"summary":"Chốt"}'::jsonb, '<' || gen_random_uuid()::text || '@erase.test>', 'queued' FROM crove_kernel.mail_message WHERE org_id = $1 AND source = 'meetings.followup' AND source_id = $2 LIMIT 1`,
          [orgId, same],
        );
        const foreign = (await sqlAdmin<{ id: string }>(
          `INSERT INTO crove_kernel.mail_message (org_id, stream, source, source_id, template_key, to_address, to_hash, subject, payload, message_id_header, status) VALUES ($1, 'transactional', 'finance.payment_reminder.notice1', $2, 'x.y', 'a@b.test', repeat('d', 64), $3, '{"keep":true}'::jsonb, '<' || gen_random_uuid()::text || '@erase.test>', 'queued') RETURNING id`,
          [orgId, same, `Gửi ${value}`],
        )).rows[0]!.id;
        await erase(value);
        expect((await mail(clean))[0]?.payload).not.toBeNull();
        const rows = await mail(same);
        expect(rows.filter((r) => r.payload === null && r.subject === null)).toHaveLength(1);
        expect(rows.filter((r) => r.subject === 'Không có giá trị')).toHaveLength(1);
        expect((await sqlAdmin<{ subject: string | null; payload: unknown }>('SELECT subject, payload FROM crove_kernel.mail_message WHERE org_id = $1 AND id = $2', [orgId, foreign])).rows[0]).toEqual({ subject: `Gửi ${value}`, payload: { keep: true } });
      });

      it('keeps the mail of a meeting the owner cannot read, and counts it with the reason', async () => {
        const value = 'phong.kin@erase.test';
        const hidden = await seedSent({ recorder: 'recorder', summary: 'Chốt kế hoạch quý.' });
        await setSubject(hidden, `Gửi ${value}`);
        const out = await erase(value);
        expect((await mail(hidden))[0]?.subject).toBe(`Gửi ${value}`);
        expect(out.kept.find((k) => k.column === 'crove_meetings.followup_mail')).toMatchObject({ rows: 1, reason: expect.stringContaining('cannot read') });
        expect(await lastAudit()).toMatchObject({ follow_up_mails: 0 });
        // The recorder's own delete is what drops it.
        await exec('recorder', 'meetings.meeting.delete', { meetingId: hidden });
        expect((await mail(hidden))[0]).toMatchObject({ payload: null });
      });

      it('says that a mail already delivered cannot be recalled, and says it only when one was dropped', async () => {
        const value = 'da.gui@erase.test';
        const sent = await seedSent({ recorder: 'owner', summary: 'Chốt kế hoạch quý.' });
        await setSubject(sent, `Gửi ${value}`);
        await deliver(sent);
        const queued = await seedSent({ recorder: 'owner', summary: 'Chốt kế hoạch quý.' });
        await setSubject(queued, `Gửi ${LEFT}`);
        const out = await erase(value);
        expect((await mail(sent))[0]).toMatchObject({ payload: null, subject: null, status: 'sent' });
        const note = out.kept.find((k) => k.column === 'crove_kernel.mail_message.payload');
        expect(note).toMatchObject({ rows: 1 });
        expect(note?.reason).toMatch(/cannot be recalled/);
        expect(note?.reason).toMatch(/mailboxes/);
        // A queued mail is dropped (and fails to render), with no such line.
        const second = await erase(LEFT);
        expect((await mail(queued))[0]).toMatchObject({ payload: null, subject: null, status: 'queued' });
        expect(second.kept.find((k) => k.column === 'crove_kernel.mail_message.payload')).toBeUndefined();
        expect(JSON.stringify(await lastAudit())).not.toContain('cannot be recalled');
      });

      it('finds the leftover when the same erasure is run again, and answers a retry while a send holds the lock', async () => {
        const value = 'chay.lai@erase.test';
        const again = await seedSent({ recorder: 'owner', summary: `Gửi ${value} bản chốt.` });
        await sqlAdmin("UPDATE crove_meetings.meeting_result SET summary = 'Gửi bản chốt.' WHERE org_id = $1 AND meeting_id = $2", [orgId, again]);
        const holder = new pg.Client({ connectionString: adminUrl });
        await holder.connect();
        try {
          await holder.query('BEGIN');
          await holder.query('SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))', [`meetings.followup:${orgId}:${again}`]);
          await expect(erase(value)).rejects.toMatchObject({ code: 'PERSONAL_DATA_BUSY' });
        } finally {
          await holder.query('ROLLBACK');
          await holder.end();
        }
        expect((await mail(again))[0]?.payload).not.toBeNull();
        await erase(value);
        expect((await mail(again))[0]).toMatchObject({ payload: null, subject: null });
        // A second run finds nothing more.
        await erase(value);
        expect(await lastAudit()).toMatchObject({ follow_up_mails: 0 });
      });
    });
  });
});

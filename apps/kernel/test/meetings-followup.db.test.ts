// SPDX-License-Identifier: AGPL-3.0-only
// The follow-up email after a meeting (L3, #2590, ADR-0047) on PostgreSQL 17: the recorder's draft from the published summary, and the send that queues one mail per
// recipient. The send checks every text the same way whatever its origin, flags an address outside the meeting until the recorder ticks it, asks a tick to send again, refuses
// a draft the published result has moved past, caps the sends per meeting per day, runs once per idempotency key, and audits counts and ids only.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { FOLLOWUP_SENDS_PER_MEETING_PER_DAY, type FollowupDraft, type FollowupSent } from '@crove/kernel-contract';
import { Runtime } from '@crove/kernel-runtime';
import { meetingsCommands, meetingsQueries } from '@crove/mod-meetings';
import { TEST_MANIFESTS } from './invariant/fixtures/manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('the follow-up email of a meeting (#2590)', () => {
  const dbName = `crove_test_followup_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let runtime: Runtime;
  let orgId = '';
  const users: Record<string, string> = {};
  const asUser = (who: string) => ({ type: 'user' as const, userId: users[who] as string, aal: 'aal1' as const });
  const exec = <O = unknown>(who: string, name: string, input: unknown, idempotencyKey?: string) => runtime.execute<O>(name, input, { actor: asUser(who), orgId, ...(idempotencyKey ? { idempotencyKey } : {}) });
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

  // A meeting recorded by `recorder`, shared with `readers`, with a published summary, one decision and one action item.
  async function seedPublished(readers: string[], summary = 'Chốt báo giá tuần này.'): Promise<string> {
    const meetingId = randomUUID();
    await sqlAdmin(
      `INSERT INTO crove_meetings.meeting (org_id, id, title, language, started_at, ended_at, length_seconds, recorder_user_id, visibility, status, consent_method, consent_confirmed_by, consent_confirmed_at, consent_notice_version, audio_retention_date, text_retention_date)
       VALUES ($1, $2, 'Họp tuần', 'vi', now(), now() + interval '30 minutes', 1800, $3, 'attendees', 'ready', 'told_at_start', $3, now(), '1.0', current_date + 30, current_date + 365)`,
      [orgId, meetingId, users.recorder],
    );
    for (const reader of readers) await sqlAdmin('INSERT INTO crove_meetings.meeting_reader (org_id, id, meeting_id, user_id) VALUES ($1, $2, $3, $4)', [orgId, randomUUID(), meetingId, users[reader]]);
    await publish(meetingId, summary);
    return meetingId;
  }
  async function publish(meetingId: string, summary: string): Promise<void> {
    await exec('recorder', 'meetings.summary.save', { meetingId, summary, decisions: ['Giữ giá cũ'] });
    await exec('recorder', 'meetings.action_item.create', { meetingId, title: 'Gửi báo giá cho khách', who: 'An', whoUserId: users.attendee, when: 'thứ sáu', whenDate: '2026-11-13', transcriptSeconds: 120 });
    await exec('recorder', 'meetings.result.publish', { meetingId, confirmed: true });
  }
  const WORDS = { greeting: 'Xin chào,', lead: 'Cảm ơn mọi người đã dành thời gian cho cuộc họp.', closing: 'Nếu có gì chưa đúng, mọi người báo lại giúp. Cảm ơn.' };
  const send = async (meetingId: string, over: Record<string, unknown> = {}, who = 'recorder', key: string = randomUUID()) => {
    const draft = await query<FollowupDraft>('recorder', 'meetings.followup.draft', { meetingId });
    return exec<FollowupSent>(
      who,
      'meetings.followup.send',
      { meetingId, factsKey: draft.factsKey, subject: 'Tóm tắt cuộc họp', ...WORDS, recipients: ['attendee@followup.test'], confirmedOutsiders: [], confirmRepeat: false, fromVy: false, reviewed: false, ...over },
      key,
    );
  };
  const mails = (meetingId: string) =>
    sqlAdmin<{ to_address: string; status: string; source: string; source_id: string; template_key: string; payload: Record<string, unknown> }>(
      "SELECT to_address, status, source, source_id, template_key, payload FROM crove_kernel.mail_message WHERE org_id = $1 AND source_id = $2 AND source = 'meetings.followup' ORDER BY created_at, id",
      [orgId, meetingId],
    ).then((r) => r.rows);

  beforeAll(async () => {
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw' });
    const url = new URL(adminUrl);
    url.username = 'crove_app';
    url.password = 'test-app-pw';
    pool = createPool({ connectionString: url.toString(), max: 4 });
    runtime = new Runtime(createDb(pool), { manifests: TEST_MANIFESTS }).register({
      commands: [...kernelCommands, ...meetingsCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...meetingsQueries],
    });
    for (const key of ['owner', 'recorder', 'attendee', 'other']) {
      users[key] = await upsertIdentity(createDb(pool), { issuer: 'followup', subject: key, email: `${key}@followup.test`, name: null });
    }
    orgId = (await createOrg(runtime, asUser('owner'), 'Công ty Tiên Phong')).orgId;
    await sqlAdmin("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member'), ($1, $4, 'member')", [orgId, users.recorder, users.attendee, users.other]);
  }, 300_000);

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('drafts from the published summary for the recorder only, with the fixed words and the people who took part', async () => {
    const meetingId = randomUUID();
    await sqlAdmin(
      `INSERT INTO crove_meetings.meeting (org_id, id, title, language, started_at, recorder_user_id, visibility, status, consent_method, consent_confirmed_by, consent_confirmed_at, consent_notice_version, audio_retention_date, text_retention_date)
       VALUES ($1, $2, 'Họp chưa chia sẻ', 'vi', now(), $3, 'attendees', 'ready', 'told_at_start', $3, now(), '1.0', current_date + 30, current_date + 365)`,
      [orgId, meetingId, users.recorder],
    );
    // Nothing is published yet: no draft of a mail from words nobody read.
    expect(await refuses(query('recorder', 'meetings.followup.draft', { meetingId }))).toBe('NO_PUBLISHED_SUMMARY');
    const m = await seedPublished(['attendee']);
    const partyId = (await sqlAdmin<{ id: string }>("INSERT INTO crove_kernel.party (org_id, name, kind, email) VALUES ($1, 'Công ty Khách', 'organization', 'Khach@KhachHang.test') RETURNING id", [orgId])).rows[0]!.id;
    await exec('recorder', 'meetings.link.add', { meetingId: m, kind: 'party', targetId: partyId });
    const draft = await query<FollowupDraft>('recorder', 'meetings.followup.draft', { meetingId: m });
    expect(draft).toMatchObject({ meetingId: m, lang: 'vi', org: 'Công ty Tiên Phong', sendsLeft: FOLLOWUP_SENDS_PER_MEETING_PER_DAY });
    expect(draft.facts).toEqual({ summary: 'Chốt báo giá tuần này.', decisions: ['Giữ giá cũ'], items: [{ title: 'Gửi báo giá cho khách', who: 'An', when: 'thứ sáu' }] });
    expect(draft.words.greeting).toBe('Xin chào,');
    expect(draft.recipients.map((r) => [r.kind, r.email, r.alreadySent])).toEqual([
      ['attendee', 'attendee@followup.test', false],
      ['party', 'khach@khachhang.test', false],
    ]);
    // Nobody but the recorder reads a draft of the follow-up.
    expect(await refuses(query('attendee', 'meetings.followup.draft', { meetingId: m }))).toBe('FORBIDDEN');
    expect(await refuses(query('other', 'meetings.followup.draft', { meetingId: m }))).toBe('MEETING_NOT_FOUND');
  });

  it('queues one mail per recipient from the published facts, audits counts only, and stores nothing before the click', async () => {
    const m = await seedPublished(['attendee']);
    expect(await mails(m)).toEqual([]);
    const sent = await send(m, { recipients: ['attendee@followup.test', 'ATTENDEE@followup.test '] });
    expect(sent).toMatchObject({ meetingId: m, queued: 1, suppressed: 0 });
    const rows = await mails(m);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ to_address: 'attendee@followup.test', status: 'queued', source: 'meetings.followup', source_id: m, template_key: 'meetings.followup' });
    expect(rows[0]?.payload).toMatchObject({ lang: 'vi', batch: sent.batchId, facts: { summary: 'Chốt báo giá tuần này.' } });
    const audit = await sqlAdmin<{ detail: Record<string, unknown> }>("SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'meetings.followup.send' AND detail ->> 'meetingId' = $2", [orgId, m]);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]?.detail).toMatchObject({ meetingId: m, batchId: sent.batchId, recipients: 1, queued: 1, suppressed: 0 });
    // No address and no word of the mail in the audit row.
    const text = JSON.stringify(audit.rows[0]?.detail);
    expect(text).not.toContain('followup.test');
    expect(text).not.toContain('Cảm ơn');
    expect(text).not.toContain('báo giá');
    // Only the recorder sends.
    expect(await refuses(send(m, {}, 'attendee'))).toBe('FORBIDDEN');
    expect(await refuses(send(m, {}, 'other'))).toBe('MEETING_NOT_FOUND');
  });

  it('checks every text the same way whatever its origin: a figure, a link, an empty or a too long text is refused, and a text from Vy needs the recorder\'s tick', async () => {
    const m = await seedPublished(['attendee']);
    const bad = async (over: Record<string, unknown>) => refuses(send(m, over));
    expect(await bad({ lead: 'Bạn thanh toán 5.000.000 đồng nhé.' })).toBe('FOLLOWUP_TEXT_INVALID');
    expect(await bad({ closing: 'Hãy trả lời trong hai mươi ngày.' })).toBe('FOLLOWUP_TEXT_INVALID');
    expect(await bad({ lead: 'Xem thêm tại https://example.test/abc' })).toBe('FOLLOWUP_TEXT_INVALID');
    expect(await bad({ greeting: 'Gửi mail về a@b.test' })).toBe('FOLLOWUP_TEXT_INVALID');
    expect(await bad({ greeting: '   ' })).toBe('FOLLOWUP_TEXT_INVALID');
    expect(await bad({ lead: 'Cảm ơn bạn. '.repeat(100) })).toBe('FOLLOWUP_TEXT_INVALID');
    expect(await bad({ subject: 'Xem www.evil.test' })).toBe('FOLLOWUP_TEXT_INVALID');
    // Said to be Vy's, the same checks apply, and the tick is required first.
    expect(await bad({ fromVy: true, reviewed: false })).toBe('FOLLOWUP_NOT_REVIEWED');
    expect(await bad({ fromVy: true, reviewed: true, lead: 'Thanh toán 100 đồng.' })).toBe('FOLLOWUP_TEXT_INVALID');
    expect(await mails(m)).toEqual([]);
    expect(await send(m, { fromVy: true, reviewed: true })).toMatchObject({ queued: 1 });
  });

  it('flags an address outside the meeting until the recorder ticks it, one address at a time', async () => {
    const m = await seedPublished(['attendee']);
    expect(await refuses(send(m, { recipients: ['attendee@followup.test', 'ngoai@ngoai.test'] }))).toBe('RECIPIENT_NOT_CONFIRMED');
    // A tick on another address does not cover this one.
    expect(await refuses(send(m, { recipients: ['ngoai@ngoai.test'], confirmedOutsiders: ['khac@ngoai.test'] }))).toBe('RECIPIENT_NOT_CONFIRMED');
    expect(await refuses(send(m, { recipients: ['không phải thư'] }))).toBe('RECIPIENT_INVALID');
    expect(await mails(m)).toEqual([]);
    expect(await send(m, { recipients: ['attendee@followup.test', 'ngoai@ngoai.test'], confirmedOutsiders: ['Ngoai@ngoai.test'] })).toMatchObject({ queued: 2 });
    const audit = await sqlAdmin<{ detail: Record<string, unknown> }>("SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'meetings.followup.send' AND detail ->> 'meetingId' = $2", [orgId, m]);
    expect(audit.rows[0]?.detail).toMatchObject({ recipients: 2, outsiders: 1 });
  });

  it('records a suppressed address as suppressed and never queues it', async () => {
    const m = await seedPublished(['attendee']);
    await exec('owner', 'kernel.mail.suppression.add', { email: 'chan@followup.test', scope: 'all' });
    const sent = await send(m, { recipients: ['attendee@followup.test', 'chan@followup.test'], confirmedOutsiders: ['chan@followup.test'] });
    expect(sent).toMatchObject({ queued: 1, suppressed: 1 });
    expect((await mails(m)).map((r) => [r.to_address, r.status])).toEqual([['attendee@followup.test', 'queued'], ['chan@followup.test', 'suppressed']]);
  });

  it('asks a tick to send again to an address that already got the mail', async () => {
    const m = await seedPublished(['attendee']);
    await send(m);
    expect((await query<FollowupDraft>('recorder', 'meetings.followup.draft', { meetingId: m })).recipients[0]?.alreadySent).toBe(true);
    expect(await refuses(send(m))).toBe('ALREADY_SENT');
    expect(await send(m, { confirmRepeat: true })).toMatchObject({ queued: 1 });
    expect(await mails(m)).toHaveLength(2);
  });

  it('refuses a draft the published result has moved past, and takes the facts from the published result again', async () => {
    const m = await seedPublished(['attendee']);
    const draft = await query<FollowupDraft>('recorder', 'meetings.followup.draft', { meetingId: m });
    await exec('recorder', 'meetings.summary.save', { meetingId: m, summary: 'Đổi kế hoạch: gặp khách thứ hai.', decisions: [] });
    // A draft of the summary is not the published one: the key still holds.
    expect(await send(m, { factsKey: draft.factsKey })).toMatchObject({ queued: 1 });
    await exec('recorder', 'meetings.result.publish', { meetingId: m, confirmed: true });
    const err = await exec('recorder', 'meetings.followup.send', {
      meetingId: m, factsKey: draft.factsKey, subject: 'Tóm tắt', ...WORDS, recipients: ['attendee@followup.test'], confirmedOutsiders: [], confirmRepeat: true, fromVy: false, reviewed: false,
    }, randomUUID()).then(() => null, (e: unknown) => (e as { code?: string }).code);
    expect(err).toBe('STALE_FOLLOWUP');
    const fresh = await query<FollowupDraft>('recorder', 'meetings.followup.draft', { meetingId: m });
    expect(fresh.factsKey).not.toBe(draft.factsKey);
    expect(fresh.facts.summary).toBe('Đổi kế hoạch: gặp khách thứ hai.');
  });

  it('caps the sends of one meeting per day, whatever the number of recipients', async () => {
    const m = await seedPublished(['attendee']);
    for (let i = 0; i < FOLLOWUP_SENDS_PER_MEETING_PER_DAY; i += 1) expect(await send(m, { confirmRepeat: true })).toMatchObject({ queued: 1 });
    expect((await query<FollowupDraft>('recorder', 'meetings.followup.draft', { meetingId: m })).sendsLeft).toBe(0);
    expect(await refuses(send(m, { confirmRepeat: true }))).toBe('FOLLOWUP_LIMIT');
    expect(await mails(m)).toHaveLength(FOLLOWUP_SENDS_PER_MEETING_PER_DAY);
    // Another meeting has a count of its own.
    expect(await send(await seedPublished(['attendee']))).toMatchObject({ queued: 1 });
  });

  it('runs once per idempotency key: a double click or a retry answers the first send and queues nothing more', async () => {
    const m = await seedPublished(['attendee']);
    const key = randomUUID();
    const first = await send(m, {}, 'recorder', key);
    const again = await send(m, {}, 'recorder', key);
    expect(again).toEqual(first);
    expect(await mails(m)).toHaveLength(1);
    // The same key with another request is a different request, not a retry.
    expect(await refuses(send(m, { subject: 'Một tiêu đề khác' }, 'recorder', key))).toBe('IDEMPOTENCY_MISMATCH');
    // Two sends at once (two clicks, two keys) meet one another at the lock and the second asks its tick.
    const m2 = await seedPublished(['attendee']);
    const results = await Promise.all([refuses(send(m2)), refuses(send(m2))]);
    expect(results.filter((r) => r === null)).toHaveLength(1);
    expect(results.filter((r) => r === 'ALREADY_SENT')).toHaveLength(1);
    expect(await mails(m2)).toHaveLength(1);
  });
});

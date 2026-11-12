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
import type { FollowupDraft } from '@crove/kernel-contract';
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
  async function seedSent(): Promise<string> {
    const meetingId = randomUUID();
    await sqlAdmin(
      `INSERT INTO crove_meetings.meeting (org_id, id, title, language, started_at, ended_at, length_seconds, recorder_user_id, visibility, status, consent_method, consent_confirmed_by, consent_confirmed_at, consent_notice_version, audio_retention_date, text_retention_date)
       VALUES ($1, $2, 'Họp tuần', 'vi', now(), now() + interval '30 minutes', 1800, $3, 'attendees', 'ready', 'told_at_start', $3, now(), '1.0', current_date + 30, current_date + 365)`,
      [orgId, meetingId, users.recorder],
    );
    await sqlAdmin('INSERT INTO crove_meetings.meeting_reader (org_id, id, meeting_id, user_id) VALUES ($1, $2, $3, $4)', [orgId, randomUUID(), meetingId, users.attendee]);
    await exec('recorder', 'meetings.summary.save', { meetingId, summary: 'Chốt báo giá tuần này.', decisions: ['Giữ giá cũ'] });
    await exec('recorder', 'meetings.result.publish', { meetingId, confirmed: true });
    const draft = await query<FollowupDraft>('recorder', 'meetings.followup.draft', { meetingId });
    await exec(
      'recorder',
      'meetings.followup.send',
      { meetingId, factsKey: draft.factsKey, subject: 'Tóm tắt', greeting: 'Xin chào,', lead: 'Cảm ơn mọi người.', closing: 'Cảm ơn.', recipients: ['attendee@erase.test'], confirmedOutsiders: [], confirmRepeat: false, fromVy: false, reviewed: false },
      randomUUID(),
    );
    return meetingId;
  }
  const mail = (meetingId: string) =>
    sqlAdmin<{ payload: unknown; status: string; to_address: string | null }>("SELECT payload, status, to_address FROM crove_kernel.mail_message WHERE org_id = $1 AND source = 'meetings.followup' AND source_id = $2", [orgId, meetingId]).then((r) => r.rows);
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
});

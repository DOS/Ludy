// SPDX-License-Identifier: AGPL-3.0-only
// Notes N10 (#1679): linking notes to meetings, reading link availability against meeting access/retention/module state,
// saving a meeting summary into an org note that starts tainted until edited, and enforcing the DB taint guard.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import type { Note, NoteRecordPanel, NoteWritten } from '@ludy/kernel-contract';
import { Runtime, type BlobStore } from '@ludy/kernel-runtime';
import { meetingsCommands, meetingsQueries } from '@ludy/mod-meetings';
import { notesCommands, notesQueries } from '@ludy/mod-notes';
import { createAuthenticator } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { saveMeetingSummaryAsNote } from '../src/notes-meeting-summary.ts';
import { createSessionStatusSource } from '../src/sessions.ts';
import { TEST_MANIFESTS } from './invariant/fixtures/manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const ISSUER = 'notes-n10';
const SIGNING_PHRASE = 'x'.repeat(32);
const suite = ADMIN ? describe : describe.skip;

suite('Notes N10: link notes to meetings and taint-until-edited guard (#1679)', () => {
  const dbName = `crove_test_notes_n10_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  const pools: pg.Pool[] = [];
  let orgId = '';
  let orgSlug = '';
  let runtime: Runtime;
  let runtimeNoMeetings: Runtime;
  let httpApp: ReturnType<typeof createHttpApp>;
  const users: Record<string, string> = {};

  const asUser = (who: string) => ({ type: 'user' as const, userId: users[who] as string, aal: 'aal1' as const });
  const exec = <O = unknown>(who: string, name: string, input: unknown, rt = runtime) =>
    rt.execute<O>(name, input, { actor: asUser(who), orgId });
  const query = <O = unknown>(who: string, name: string, input: unknown, rt = runtime) =>
    rt.query<O>(name, input, { actor: asUser(who), orgId });
  const saveSummary = (who: string, input: { meetingId: string; title?: string }, rt = runtime) =>
    saveMeetingSummaryAsNote(rt, orgId, asUser(who), input);

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }
  const sqlAdmin = <R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params: unknown[] = []) =>
    admin((c) => c.query<R>(text, params));

  async function seedMeeting(
    recorder: string,
    readers: string[],
    opts: { title?: string; visibility?: 'attendees' | 'org'; textRetentionDaysOffset?: number } = {},
  ): Promise<string> {
    const meetingId = randomUUID();
    const title = opts.title ?? 'Họp chốt báo giá Q4';
    const visibility = opts.visibility ?? 'attendees';
    const days = opts.textRetentionDaysOffset ?? 365;
    await sqlAdmin(
      `INSERT INTO crove_meetings.meeting (
         org_id, id, title, language, started_at, ended_at, length_seconds,
         recorder_user_id, visibility, status, consent_method, consent_confirmed_by,
         consent_confirmed_at, consent_notice_version, audio_retention_date, text_retention_date
       )
       VALUES (
         $1, $2, $3, 'vi', now(), now() + interval '30 minutes', 1800,
         $4, $5, 'ready', 'told_at_start', $4,
         now(), '1.0', current_date + 30, current_date + $6::int
       )`,
      [orgId, meetingId, title, users[recorder], visibility, days],
    );
    for (const reader of readers) {
      await sqlAdmin(
        `INSERT INTO crove_meetings.meeting_reader (org_id, id, meeting_id, user_id) VALUES ($1, $2, $3, $4)`,
        [orgId, randomUUID(), meetingId, users[reader]],
      );
    }
    return meetingId;
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
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw' });

    const url = new URL(adminUrl);
    url.username = 'crove_app';
    url.password = 'test-app-pw';
    appUrl = url.toString();
    const pool = createPool({ connectionString: appUrl, max: 4 });
    pools.push(pool);
    const db = createDb(pool);

    runtime = new Runtime(db, { manifests: TEST_MANIFESTS }).register({
      commands: [...kernelCommands, ...meetingsCommands, ...notesCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...meetingsQueries, ...notesQueries],
    });
    runtimeNoMeetings = new Runtime(db, { manifests: TEST_MANIFESTS, absentModules: ['meetings'] }).register({
      commands: [...kernelCommands, ...notesCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...notesQueries],
    });

    const httpConfig = loadConfig({
      DATABASE_URL: appUrl,
      AUTH_JWT_SECRET: SIGNING_PHRASE,
      AUTH_ISSUER: ISSUER,
      AUTH_SESSION_CHECK: 'off',
      MIGRATIONS_DIR: MIGRATIONS,
      WEB_DIST: '/nonexistent',
    });
    const httpRuntime = new Runtime(db, {
      manifests: TEST_MANIFESTS,
      sessions: createSessionStatusSource('off'),
    }).register({
      commands: [...kernelCommands, ...meetingsCommands, ...notesCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...meetingsQueries, ...notesQueries],
    });
    httpApp = createHttpApp({
      config: httpConfig,
      runtime: httpRuntime,
      store: {} as BlobStore,
      authenticate: createAuthenticator(httpConfig, db),
      pool,
      aiEnabled: false,
    });

    for (const key of ['owner', 'recorder', 'attendee', 'other', 'viewer']) {
      users[key] = await upsertIdentity(db, { issuer: ISSUER, subject: key, email: `${key}@notes-n10.test`, name: null });
    }
    const createdOrg = await createOrg(runtime, asUser('owner'), 'Notes N10 Org');
    orgId = createdOrg.orgId;
    orgSlug = createdOrg.slug;
    await sqlAdmin(
      `INSERT INTO crove_kernel.tenant_member (org_id, user_id, role)
       VALUES ($1, $2, 'member'), ($1, $3, 'member'), ($1, $4, 'member'), ($1, $5, 'viewer')`,
      [orgId, users.recorder, users.attendee, users.other, users.viewer],
    );
  }, 300_000);

  afterAll(async () => {
    for (const pool of pools) await pool.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('links notes to meetings, gates link creation and link availability by meeting access/retention/module state', async () => {
    const meetingId = await seedMeeting('recorder', ['attendee'], { title: 'Họp riêng khách VIP' });
    const expiredId = await seedMeeting('recorder', ['attendee'], {
      title: 'Họp quá hạn lưu',
      visibility: 'org',
      textRetentionDaysOffset: -1,
    });

    const { noteId } = await exec<NoteWritten>('recorder', 'notes.note.create', {
      title: 'Theo dõi sau họp VIP',
      visibility: 'org',
      link: { targetType: 'meetings.meeting', targetId: meetingId },
    });

    // Recorder and attendee can open the linked meeting; non-attendee whole-org member sees the org note
    // with available: false so meeting existence/access never leaks.
    const asRecorder = await query<Note>('recorder', 'notes.note.get', { noteId });
    expect(asRecorder.links).toEqual([
      expect.objectContaining({ targetType: 'meetings.meeting', targetId: meetingId, available: true }),
    ]);

    const asAttendee = await query<Note>('attendee', 'notes.note.get', { noteId });
    expect(asAttendee.links).toEqual([
      expect.objectContaining({ targetType: 'meetings.meeting', targetId: meetingId, available: true }),
    ]);

    const asOther = await query<Note>('other', 'notes.note.get', { noteId });
    expect(asOther.links).toEqual([
      expect.objectContaining({ targetType: 'meetings.meeting', targetId: meetingId, available: false }),
    ]);

    // Meeting record panel shows the linked note for readers.
    const panel = await query<NoteRecordPanel>('attendee', 'notes.record.panel', {
      targetType: 'meetings.meeting',
      targetId: meetingId,
    });
    expect(panel.latest.map((n) => n.id)).toEqual([noteId]);

    // Non-attendee cannot add a link to an unreadable meeting, nor create a note linked to it.
    const { noteId: otherNote } = await exec<NoteWritten>('other', 'notes.note.create', { title: 'Ghi chú của other' });
    await expect(
      exec('other', 'notes.link.add', { noteId: otherNote, targetType: 'meetings.meeting', targetId: meetingId }),
    ).rejects.toMatchObject({ code: 'NOTE_LINK_TARGET_NOT_FOUND', status: 404 });
    await expect(
      exec('other', 'notes.note.create', {
        title: 'Thử gắn họp cấm',
        link: { targetType: 'meetings.meeting', targetId: meetingId },
      }),
    ).rejects.toMatchObject({ code: 'NOTE_LINK_TARGET_NOT_FOUND', status: 404 });

    // Retention-expired meeting cannot be linked.
    await expect(
      exec('recorder', 'notes.link.add', { noteId, targetType: 'meetings.meeting', targetId: expiredId }),
    ).rejects.toMatchObject({ code: 'NOTE_LINK_TARGET_NOT_FOUND', status: 404 });

    // When meetings module is disabled, existing meeting links gracefully show available: false,
    // new meeting links are rejected as unreadable target, and from_meeting_summary returns NOTES_MEETING_UNAVAILABLE.
    const whenOff = await query<Note>('recorder', 'notes.note.get', { noteId }, runtimeNoMeetings);
    expect(whenOff.links).toEqual([
      expect.objectContaining({ targetType: 'meetings.meeting', targetId: meetingId, available: false }),
    ]);
    await expect(
      exec('recorder', 'notes.link.add', { noteId, targetType: 'meetings.meeting', targetId: meetingId }, runtimeNoMeetings),
    ).rejects.toMatchObject({ code: 'NOTE_LINK_TARGET_NOT_FOUND', status: 404 });
    await expect(
      saveSummary('recorder', { meetingId }, runtimeNoMeetings),
    ).rejects.toMatchObject({ code: 'NOTES_MEETING_UNAVAILABLE', status: 400 });
    await expect(
      exec('recorder', 'notes.note.from_meeting_summary', { meetingId, title: 'Tóm tắt', body: 'Nội dung' }, runtimeNoMeetings),
    ).rejects.toMatchObject({ code: 'NOTES_MEETING_UNAVAILABLE', status: 400 });
  });

  it('saves a meeting summary (draft for recorder, published for readers) as a tainted org note without leaking content in audit/outbox', async () => {
    const meetingId = await seedMeeting('recorder', ['attendee'], { title: 'Họp triển khai pilot' });
    const SECRET_SUMMARY = 'Chốt đơn giá 490.000đ cho gói tháng và bàn giao thứ sáu.';
    const DECISION_1 = 'Giữ nguyên bảng giá pilot';
    const DECISION_2 = 'Ký biên bản nghiệm thu';

    // Empty summary -> 409 MEETING_SUMMARY_EMPTY for reader; 404 MEETING_NOT_FOUND for non-reader (zero oracle).
    await expect(
      saveSummary('recorder', { meetingId }),
    ).rejects.toMatchObject({ code: 'MEETING_SUMMARY_EMPTY', status: 409 });
    await expect(
      saveSummary('other', { meetingId }),
    ).rejects.toMatchObject({ code: 'MEETING_NOT_FOUND', status: 404 });

    // Unreviewed AI draft (tainted: true) cannot be shared into an org note before recorder review (DRAFT_NOT_REVIEWED).
    await admin(async (c) => {
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query(
        `INSERT INTO crove_meetings.meeting_result (org_id, meeting_id, summary, decisions, feature, stage, tainted)
         VALUES ($1, $2, $3, $4::jsonb, 'meetings.summary', 'draft', true)`,
        [orgId, meetingId, SECRET_SUMMARY, JSON.stringify([DECISION_1, DECISION_2])],
      );
      await c.query('COMMIT');
    });
    await expect(
      saveSummary('recorder', { meetingId }),
    ).rejects.toMatchObject({ code: 'DRAFT_NOT_REVIEWED', status: 409 });

    // Recorder edits/saves draft (clearing meeting draft taint) -> can now copy to a tainted org note.
    await exec('recorder', 'meetings.summary.save', {
      meetingId,
      summary: SECRET_SUMMARY,
      decisions: [DECISION_1, DECISION_2],
    });

    // Attendee still sees no published summary yet -> 409 MEETING_SUMMARY_EMPTY.
    await expect(
      saveSummary('attendee', { meetingId }),
    ).rejects.toMatchObject({ code: 'MEETING_SUMMARY_EMPTY', status: 409 });

    // Viewer / agent / system cannot create notes from meeting summary.
    await expect(
      saveSummary('viewer', { meetingId }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      exec('viewer', 'notes.note.from_meeting_summary', { meetingId, title: 'x', body: 'y' }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      runtime.execute(
        'notes.note.from_meeting_summary',
        { meetingId, title: 'x', body: 'y' },
        { actor: { type: 'system', component: 'test' }, orgId },
      ),
    ).rejects.toMatchObject({ status: 403 });

    // Recorder saves from unpublished draft -> creates org-shared tainted note linked to the meeting.
    const fromDraft = await saveSummary('recorder', { meetingId });
    expect(Object.keys(fromDraft).sort()).toEqual(['noteId', 'revision']);

    const draftNote = await query<Note>('attendee', 'notes.note.get', { noteId: fromDraft.noteId });
    expect(draftNote).toMatchObject({
      id: fromDraft.noteId,
      visibility: 'org',
      tainted: true,
      tags: [],
      title: 'Họp triển khai pilot',
      body: `${SECRET_SUMMARY}\n\n## Quyết định\n- ${DECISION_1}\n- ${DECISION_2}`,
    });
    expect(draftNote.links).toEqual([
      expect.objectContaining({ targetType: 'meetings.meeting', targetId: meetingId, available: true }),
    ]);

    // Whole-org non-attendee reads the org note but cannot open its meeting link.
    const asOther = await query<Note>('other', 'notes.note.get', { noteId: fromDraft.noteId });
    expect(asOther.tainted).toBe(true);
    expect(asOther.links).toEqual([
      expect.objectContaining({ targetType: 'meetings.meeting', targetId: meetingId, available: false }),
    ]);

    // Publish results -> attendee can now save published summary into a new tainted org note with optional custom title.
    await exec('recorder', 'meetings.result.publish', { meetingId, confirmed: true });
    const fromPublished = await saveSummary('attendee', {
      meetingId,
      title: 'Biên bản họp pilot tháng 11',
    });
    const pubNote = await query<Note>('attendee', 'notes.note.get', { noteId: fromPublished.noteId });
    expect(pubNote).toMatchObject({
      id: fromPublished.noteId,
      visibility: 'org',
      tainted: true,
      tags: [],
      title: 'Biên bản họp pilot tháng 11',
    });

    // Audit records both the sensitive read of meetings.result.get and the note creation, without leaking raw text.
    const resultAudit = await sqlAdmin<{ command: string; target_id: string | null }>(
      `SELECT command, target_id FROM crove_kernel.audit_event
       WHERE org_id = $1 AND command = 'meetings.result.get' AND target_id = $2`,
      [orgId, meetingId],
    );
    expect(resultAudit.rows.length).toBeGreaterThanOrEqual(2);

    const auditRows = await sqlAdmin<{ command: string; outcome: string; detail: Record<string, unknown> }>(
      `SELECT command, outcome, detail FROM crove_kernel.audit_event
       WHERE org_id = $1 AND command = 'notes.note.from_meeting_summary' ORDER BY occurred_at, id`,
      [orgId],
    );
    expect(auditRows.rows.filter((r) => r.outcome === 'ok')).toHaveLength(2);
    expect(JSON.stringify(auditRows.rows)).not.toContain(SECRET_SUMMARY);
    expect(JSON.stringify(auditRows.rows)).not.toContain(DECISION_1);

    const outboxRows = await sqlAdmin<{ id: string; payload: Record<string, unknown> }>(
      `SELECT id, payload FROM crove_kernel.outbox_event
       WHERE org_id = $1 AND payload ->> 'noteId' = ANY($2::text[])`,
      [orgId, [fromDraft.noteId, fromPublished.noteId]],
    );
    expect(JSON.stringify(outboxRows.rows)).not.toContain(SECRET_SUMMARY);
    expect(JSON.stringify(outboxRows.rows)).not.toContain(DECISION_1);
  });

  it('keeps taint on tags-only updates and clears taint only when author edits title or body', async () => {
    const meetingId = await seedMeeting('recorder', ['attendee'], { title: 'Họp kiểm tra taint' });
    await exec('recorder', 'meetings.summary.save', {
      meetingId,
      summary: 'Nội dung gốc từ cuộc họp',
      decisions: [],
    });
    await exec('recorder', 'meetings.result.publish', { meetingId, confirmed: true });

    const { noteId } = await saveSummary('attendee', { meetingId });
    let detail = await query<Note>('attendee', 'notes.note.get', { noteId });
    expect(detail.tainted).toBe(true);

    // Non-content update (tags only, identical title and body) preserves tainted = true.
    const tagUpdate = await exec<NoteWritten>('attendee', 'notes.note.update', {
      noteId,
      revision: detail.revision,
      title: detail.title,
      body: detail.body,
      tags: ['pilot'],
    });
    detail = await query<Note>('attendee', 'notes.note.get', { noteId });
    expect(detail.tainted).toBe(true);
    expect(detail.tags).toEqual(['pilot']);

    // Author edits body through notes.note.update -> clears tainted = false and records 'tainted' in audit changed.
    await exec<NoteWritten>('attendee', 'notes.note.update', {
      noteId,
      revision: tagUpdate.revision,
      title: detail.title,
      body: `${detail.body}\n\nĐã rà soát.`,
      tags: ['pilot'],
    });
    detail = await query<Note>('attendee', 'notes.note.get', { noteId });
    expect(detail.tainted).toBe(false);

    const updateAudit = await sqlAdmin<{ detail: { changed?: string[] } }>(
      `SELECT detail FROM crove_kernel.audit_event
       WHERE org_id = $1 AND command = 'notes.note.update' ORDER BY occurred_at DESC, id DESC LIMIT 1`,
      [orgId],
    );
    expect(updateAudit.rows[0]?.detail.changed).toContain('tainted');

    // End-to-end HTTP RPC check: /api/rpc/notes/fromMeetingSummary accepts { meetingId } and rejects unknown body injection.
    const jwt = await new SignJWT({
      role: 'authenticated',
      email: 'attendee@notes-n10.test',
      session_id: randomUUID(),
      aal: 'aal1',
      is_anonymous: false,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('attendee')
      .setIssuer(ISSUER)
      .setAudience('authenticated')
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(new TextEncoder().encode(SIGNING_PHRASE));

    const badRes = await httpApp.request('/api/rpc/notes/fromMeetingSummary', {
      method: 'POST',
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json', 'x-crove-org': orgSlug },
      body: JSON.stringify({ json: { meetingId, body: 'spoofed text' } }),
    });
    expect(badRes.status).toBe(400);

    const okRes = await httpApp.request('/api/rpc/notes/fromMeetingSummary', {
      method: 'POST',
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json', 'x-crove-org': orgSlug },
      body: JSON.stringify({ json: { meetingId } }),
    });
    expect(okRes.status).toBe(200);
    const okPayload = (await okRes.json()) as { json: NoteWritten };
    const httpNote = await query<Note>('attendee', 'notes.note.get', { noteId: okPayload.json.noteId });
    expect(httpNote.tainted).toBe(true);
    expect(httpNote.visibility).toBe('org');
    expect(httpNote.body).toBe('Nội dung gốc từ cuộc họp');
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
// Notes N10 (#1679): product flows for linking notes to meetings, reading the meeting record panel,
// saving a meeting summary into an org note that starts tainted until edited, and clearing taint on author edit.
// Security invariants (access/retention/module gating, DRAFT_NOT_REVIEWED, role/actor gates, HTTP strict input,
// and audit/outbox redaction) live in apps/kernel/test/invariant/notes-meeting-links.db.test.ts.
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

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const ISSUER = 'notes-n10';
const SIGNING_PHRASE = 'x'.repeat(32);
const suite = ADMIN ? describe : describe.skip;

suite('Notes N10: link notes to meetings and summary-to-note product flows (#1679)', () => {
  const dbName = `ludy_test_notes_n10_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  const pools: pg.Pool[] = [];
  let orgId = '';
  let orgSlug = '';
  let runtime: Runtime;
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
      `INSERT INTO ludy_meetings.meeting (
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
        `INSERT INTO ludy_meetings.meeting_reader (org_id, id, meeting_id, user_id) VALUES ($1, $2, $3, $4)`,
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
    await setRolePasswords(adminUrl, { ludy_app: 'test-app-pw' });

    const url = new URL(adminUrl);
    url.username = 'ludy_app';
    url.password = 'test-app-pw';
    appUrl = url.toString();
    const pool = createPool({ connectionString: appUrl, max: 4 });
    pools.push(pool);
    const db = createDb(pool);

    runtime = new Runtime(db, { manifests: TEST_MANIFESTS }).register({
      commands: [...kernelCommands, ...meetingsCommands, ...notesCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...meetingsQueries, ...notesQueries],
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

    for (const key of ['owner', 'recorder', 'attendee']) {
      users[key] = await upsertIdentity(db, { issuer: ISSUER, subject: key, email: `${key}@notes-n10.test`, name: null });
    }
    const createdOrg = await createOrg(runtime, asUser('owner'), 'Notes N10 Org');
    orgId = createdOrg.orgId;
    orgSlug = createdOrg.slug;
    await sqlAdmin(
      `INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role)
       VALUES ($1, $2, 'member'), ($1, $3, 'member')`,
      [orgId, users.recorder, users.attendee],
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

  it('links notes to meetings and surfaces linked notes on the meeting record panel', async () => {
    const meetingId = await seedMeeting('recorder', ['attendee'], { title: 'Họp riêng khách VIP' });

    const { noteId } = await exec<NoteWritten>('recorder', 'notes.note.create', {
      title: 'Theo dõi sau họp VIP',
      visibility: 'org',
      link: { targetType: 'meetings.meeting', targetId: meetingId },
    });

    const asRecorder = await query<Note>('recorder', 'notes.note.get', { noteId });
    expect(asRecorder.links).toEqual([
      expect.objectContaining({ targetType: 'meetings.meeting', targetId: meetingId, available: true }),
    ]);

    const asAttendee = await query<Note>('attendee', 'notes.note.get', { noteId });
    expect(asAttendee.links).toEqual([
      expect.objectContaining({ targetType: 'meetings.meeting', targetId: meetingId, available: true }),
    ]);

    // Meeting record panel shows the linked note for readers.
    const panel = await query<NoteRecordPanel>('attendee', 'notes.record.panel', {
      targetType: 'meetings.meeting',
      targetId: meetingId,
    });
    expect(panel.latest.map((n) => n.id)).toEqual([noteId]);
  });

  it('saves a meeting summary (draft for recorder, published for readers) into a tainted org note', async () => {
    const meetingId = await seedMeeting('recorder', ['attendee'], { title: 'Họp triển khai pilot' });
    const SUMMARY = 'Chốt đơn giá 490.000đ cho gói tháng và bàn giao thứ sáu.';
    const DECISION_1 = 'Giữ nguyên bảng giá pilot';
    const DECISION_2 = 'Ký biên bản nghiệm thu';

    await exec('recorder', 'meetings.summary.save', {
      meetingId,
      summary: SUMMARY,
      decisions: [DECISION_1, DECISION_2],
    });

    // Recorder saves from unpublished clean draft -> creates org-shared tainted note linked to the meeting.
    const fromDraft = await saveSummary('recorder', { meetingId });
    expect(Object.keys(fromDraft).sort()).toEqual(['noteId', 'revision']);

    const draftNote = await query<Note>('attendee', 'notes.note.get', { noteId: fromDraft.noteId });
    expect(draftNote).toMatchObject({
      id: fromDraft.noteId,
      visibility: 'org',
      tainted: true,
      tags: [],
      title: 'Họp triển khai pilot',
      body: `${SUMMARY}\n\n## Quyết định\n- ${DECISION_1}\n- ${DECISION_2}`,
    });
    expect(draftNote.links).toEqual([
      expect.objectContaining({ targetType: 'meetings.meeting', targetId: meetingId, available: true }),
    ]);

    // Publish results -> attendee saves published summary into a new tainted org note with optional custom title.
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
  });

  it('keeps taint on tags-only updates, clears taint when author edits content, and supports HTTP RPC conversion', async () => {
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
      `SELECT detail FROM ludy_kernel.audit_event
       WHERE org_id = $1 AND command = 'notes.note.update' ORDER BY occurred_at DESC, id DESC LIMIT 1`,
      [orgId],
    );
    expect(updateAudit.rows[0]?.detail.changed).toContain('tainted');

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

    const okRes = await httpApp.request('/api/rpc/notes/fromMeetingSummary', {
      method: 'POST',
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json', 'x-ludy-org': orgSlug },
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

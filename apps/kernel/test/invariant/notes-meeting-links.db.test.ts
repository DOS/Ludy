// SPDX-License-Identifier: AGPL-3.0-only
// Invariant for #1679 / #3519 (Notes N10): meeting access/retention/module-off link gating,
// DRAFT_NOT_REVIEWED and role/actor guards on saveMeetingSummaryAsNote, HTTP strict input boundary,
// and audit/outbox redaction of sensitive meeting summary text.
// Part of the invariant suite; it imports package code under test, never helpers from outside test/invariant/.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '@ludy/db';
import { migrate } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import type { Note, NoteWritten } from '@ludy/kernel-contract';
import { Runtime, type BlobStore } from '@ludy/kernel-runtime';
import { meetingsCommands, meetingsQueries } from '@ludy/mod-meetings';
import { notesCommands, notesQueries } from '@ludy/mod-notes';
import { createAuthenticator } from '../../src/auth.ts';
import { loadConfig } from '../../src/config.ts';
import { createHttpApp } from '../../src/http.ts';
import { saveMeetingSummaryAsNote } from '../../src/notes-meeting-summary.ts';
import { createSessionStatusSource } from '../../src/sessions.ts';
import { createDbClient, createDbPool, resolveDbIdentifiers, setActiveRolePasswords, type DbIdentifiers } from './fixtures/db-identifiers.ts';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const ISSUER = 'notes-meeting-links-inv';
const SIGNING_PHRASE = 'x'.repeat(32);
const suite = ADMIN ? describe : describe.skip;

suite('Notes meeting links & summary-to-note security invariants (#1679, #3519)', () => {
  const dbName = `crove_test_notes_meeting_links_inv_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let dbIds: DbIdentifiers | undefined;
  let appUrl = '';
  const pools: pg.Pool[] = [];
  let orgId = '';
  let orgSlug = '';
  let otherOrgId = '';
  let runtime: Runtime;
  let runtimeNoMeetings: Runtime;
  let httpApp: ReturnType<typeof createHttpApp>;
  const users: Record<string, string> = {};

  const asUser = (who: string) => ({ type: 'user' as const, userId: users[who] as string, aal: 'aal1' as const });
  const exec = <O = unknown>(who: string, name: string, input: unknown, rt = runtime, targetOrg = orgId) =>
    rt.execute<O>(name, input, { actor: asUser(who), orgId: targetOrg });
  const query = <O = unknown>(who: string, name: string, input: unknown, rt = runtime, targetOrg = orgId) =>
    rt.query<O>(name, input, { actor: asUser(who), orgId: targetOrg });
  const saveSummary = (who: string, input: { meetingId: string; title?: string }, rt = runtime, targetOrg = orgId) =>
    saveMeetingSummaryAsNote(rt, targetOrg, asUser(who), input);

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = createDbClient({ connectionString: adminUrl }, dbIds);
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
    const title = opts.title ?? 'Họp riêng khách VIP';
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
    dbIds = await resolveDbIdentifiers(adminUrl);
    await setActiveRolePasswords(adminUrl, { crove_app: 'test-app-pw' }, dbIds);

    const url = new URL(adminUrl);
    url.username = dbIds ? dbIds.roleName('crove_app') : 'crove_app';
    url.password = 'test-app-pw';
    appUrl = url.toString();
    const pool = createDbPool({ connectionString: appUrl, max: 4 }, dbIds);
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

    for (const key of ['owner', 'recorder', 'attendee', 'other', 'viewer', 'outsider']) {
      users[key] = await upsertIdentity(db, { issuer: ISSUER, subject: key, email: `${key}@notes-links-inv.test`, name: null });
    }
    const createdOrg = await createOrg(runtime, asUser('owner'), 'Notes Links Inv Org');
    orgId = createdOrg.orgId;
    orgSlug = createdOrg.slug;
    await sqlAdmin(
      `INSERT INTO crove_kernel.tenant_member (org_id, user_id, role)
       VALUES ($1, $2, 'member'), ($1, $3, 'member'), ($1, $4, 'member'), ($1, $5, 'viewer')`,
      [orgId, users.recorder, users.attendee, users.other, users.viewer],
    );
    otherOrgId = (await createOrg(runtime, asUser('outsider'), 'Notes Links Inv Other Org')).orgId;
    await sqlAdmin(
      `INSERT INTO crove_kernel.tenant_member (org_id, user_id, role)
       VALUES ($1, $2, 'member')`,
      [otherOrgId, users.recorder],
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

  it('gates meeting link creation and link availability by meeting access, retention, org boundary, and module state', async () => {
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

    // Non-attendee whole-org member sees the org note with available: false so meeting existence/access never leaks.
    const asOther = await query<Note>('other', 'notes.note.get', { noteId });
    expect(asOther.links).toEqual([
      expect.objectContaining({ targetType: 'meetings.meeting', targetId: meetingId, available: false }),
    ]);

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

    // Cross-org isolation: a user who holds access to the meeting in orgId still cannot link or save it from otherOrgId.
    const { noteId: otherOrgRecorderNote } = await exec<NoteWritten>(
      'recorder',
      'notes.note.create',
      { title: 'Recorder note in other org' },
      runtime,
      otherOrgId,
    );
    await expect(
      exec(
        'recorder',
        'notes.link.add',
        { noteId: otherOrgRecorderNote, targetType: 'meetings.meeting', targetId: meetingId },
        runtime,
        otherOrgId,
      ),
    ).rejects.toMatchObject({ code: 'NOTE_LINK_TARGET_NOT_FOUND', status: 404 });
    await expect(
      exec(
        'recorder',
        'notes.note.create',
        { title: 'Cross org link attempt', link: { targetType: 'meetings.meeting', targetId: meetingId } },
        runtime,
        otherOrgId,
      ),
    ).rejects.toMatchObject({ code: 'NOTE_LINK_TARGET_NOT_FOUND', status: 404 });
    await expect(
      saveSummary('recorder', { meetingId }, runtime, otherOrgId),
    ).rejects.toMatchObject({ code: 'MEETING_NOT_FOUND', status: 404 });

    // When meetings module is disabled, existing meeting links degrade to available: false,
    // new meeting links are rejected as unreadable target, and summary conversion returns NOTES_MEETING_UNAVAILABLE.
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

  it('enforces DRAFT_NOT_REVIEWED, role/actor authorization, and sensitive-read audit/outbox redaction', async () => {
    const meetingId = await seedMeeting('recorder', ['attendee'], { title: 'Họp bảo mật' });
    const SECRET_SUMMARY = 'Chốt đơn giá bí mật 490.000đ và điều khoản riêng.';
    const DECISION_1 = 'Giữ nguyên bảng giá bí mật';
    const DECISION_2 = 'Ký phụ lục bảo mật';

    // Empty summary -> 409 MEETING_SUMMARY_EMPTY for reader; 404 MEETING_NOT_FOUND for non-reader (zero oracle).
    await expect(
      saveSummary('recorder', { meetingId }),
    ).rejects.toMatchObject({ code: 'MEETING_SUMMARY_EMPTY', status: 409 });
    await expect(
      saveSummary('other', { meetingId }),
    ).rejects.toMatchObject({ code: 'MEETING_NOT_FOUND', status: 404 });

    // Unreviewed AI draft (tainted: true) cannot be copied into an org note before recorder review (DRAFT_NOT_REVIEWED).
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

    // Recorder reviews/saves draft (clearing meeting draft taint), still unpublished to attendee.
    await exec('recorder', 'meetings.summary.save', {
      meetingId,
      summary: SECRET_SUMMARY,
      decisions: [DECISION_1, DECISION_2],
    });
    await expect(
      saveSummary('attendee', { meetingId }),
    ).rejects.toMatchObject({ code: 'MEETING_SUMMARY_EMPTY', status: 409 });

    // Viewer and system actors cannot create notes from meeting summary.
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

    const snapshotAuditAndOutbox = async () => {
      const [auditIds, outboxIds] = await Promise.all([
        sqlAdmin<{ id: string }>(`SELECT id FROM crove_kernel.audit_event WHERE org_id = $1`, [orgId]),
        sqlAdmin<{ id: string }>(`SELECT id FROM crove_kernel.outbox_event WHERE org_id = $1`, [orgId]),
      ]);
      return {
        auditIds: auditIds.rows.map((r) => r.id),
        outboxIds: outboxIds.rows.map((r) => r.id),
      };
    };

    const assertConversionAuditAndOutbox = async (
      before: { auditIds: string[]; outboxIds: string[] },
      actorUserId: string,
    ) => {
      const newAuditRows = await sqlAdmin<{
        command: string;
        actor_id: string | null;
        target_id: string | null;
        outcome: string;
        detail: Record<string, unknown> | null;
      }>(
        `SELECT command, actor_id, target_id, outcome, detail FROM crove_kernel.audit_event
         WHERE org_id = $1 AND NOT (id = ANY($2::uuid[])) ORDER BY occurred_at, id`,
        [orgId, before.auditIds],
      );
      expect(newAuditRows.rows).toContainEqual(
        expect.objectContaining({
          command: 'meetings.result.get',
          actor_id: actorUserId,
          target_id: meetingId,
          outcome: 'ok',
        }),
      );
      expect(newAuditRows.rows).toContainEqual(
        expect.objectContaining({
          command: 'notes.note.from_meeting_summary',
          actor_id: actorUserId,
          outcome: 'ok',
        }),
      );
      expect(JSON.stringify(newAuditRows.rows)).not.toContain(SECRET_SUMMARY);
      expect(JSON.stringify(newAuditRows.rows)).not.toContain(DECISION_1);
      expect(JSON.stringify(newAuditRows.rows)).not.toContain(DECISION_2);

      const newOutboxRows = await sqlAdmin<{ id: string; type: string; payload: Record<string, unknown> }>(
        `SELECT id, type, payload FROM crove_kernel.outbox_event
         WHERE org_id = $1 AND NOT (id = ANY($2::uuid[])) ORDER BY created_at, id`,
        [orgId, before.outboxIds],
      );
      expect(JSON.stringify(newOutboxRows.rows)).not.toContain(SECRET_SUMMARY);
      expect(JSON.stringify(newOutboxRows.rows)).not.toContain(DECISION_1);
      expect(JSON.stringify(newOutboxRows.rows)).not.toContain(DECISION_2);
    };

    // Recorder converts clean draft and attendee converts published summary; non-attendee cannot open link.
    const beforeDraft = await snapshotAuditAndOutbox();
    const fromDraft = await saveSummary('recorder', { meetingId });
    await assertConversionAuditAndOutbox(beforeDraft, users.recorder);

    const asOther = await query<Note>('other', 'notes.note.get', { noteId: fromDraft.noteId });
    expect(asOther.tainted).toBe(true);
    expect(asOther.links).toEqual([
      expect.objectContaining({ targetType: 'meetings.meeting', targetId: meetingId, available: false }),
    ]);

    await exec('recorder', 'meetings.result.publish', { meetingId, confirmed: true });
    const beforePublished = await snapshotAuditAndOutbox();
    await saveSummary('attendee', { meetingId });
    await assertConversionAuditAndOutbox(beforePublished, users.attendee);
  });

  it('rejects body injection over HTTP RPC and forces tainted=true org visibility on converted summary notes', async () => {
    const meetingId = await seedMeeting('recorder', ['attendee'], { title: 'Họp kiểm tra HTTP RPC' });
    await exec('recorder', 'meetings.summary.save', {
      meetingId,
      summary: 'Nội dung gốc đã được duyệt',
      decisions: [],
    });
    await exec('recorder', 'meetings.result.publish', { meetingId, confirmed: true });

    const jwt = await new SignJWT({
      role: 'authenticated',
      email: 'attendee@notes-links-inv.test',
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
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json', 'x-ludy-org': orgSlug },
      body: JSON.stringify({ json: { meetingId, body: 'spoofed text' } }),
    });
    expect(badRes.status).toBe(400);

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
    expect(httpNote.body).toBe('Nội dung gốc đã được duyệt');
  });
});

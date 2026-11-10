// SPDX-License-Identifier: AGPL-3.0-only
// The taint of a transcript the recorder copied from a Vy result on PostgreSQL 17 (issue #2941, ADR-0047 point 8, ADR-0049 decision 4), the same guarantees as the summary's
// (meetings-taint.db.test.ts):
// - a copied segment is born tainted and names its run; no update sets `tainted` or changes source_run_id, a superuser included; the tenant context cannot touch either column,
//   and a correction of the text leaves the row tainted;
// - only crove_meetings.draft_review clears the mark, for the meeting's recorder alone, never for a row of another meeting;
// - a draft segment that is still tainted is never published, whoever asks (no command publishes a transcript today; this holds for the one that will).
// Part of the invariant suite; it imports package code under test, never helpers from outside test/invariant/.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { meetingsCommands, meetingsQueries } from '@crove/mod-meetings';
import { contextToken } from './fixtures/context-token.ts';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('transcript taint on PostgreSQL (#2941, ADR-0047)', () => {
  const dbName = `crove_test_meetings_transcript_taint_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  const pools: pg.Pool[] = [];
  let orgId = '';
  let runtime: Runtime;
  const users = { owner: '', recorder: '' };
  const meetingId = randomUUID();
  const otherMeetingId = randomUUID();

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }
  const asRecorder = (c: pg.Client) => c.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [orgId, contextToken(users.recorder, orgId)]);

  // Runs sql in a transaction that is always rolled back, as the recorder (the app login in their context) or as the superuser; reports the error code or the rows.
  async function attempt(who: 'recorder' | 'superuser', text: string, params: unknown[] = []): Promise<{ code: string | null; message: string; rows: number }> {
    const c = new pg.Client({ connectionString: who === 'recorder' ? appUrl : adminUrl });
    await c.connect();
    try {
      await c.query('BEGIN');
      if (who === 'recorder') await asRecorder(c);
      try {
        const res = await c.query(text, params);
        return { code: null, message: '', rows: res.rowCount ?? 0 };
      } catch (error) {
        return { code: (error as { code?: string }).code ?? 'ERR', message: (error as Error).message, rows: 0 };
      }
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      await c.end();
    }
  }

  // Runs fn as the recorder in a transaction that is COMMITTED (a review is meant to stay).
  async function withRecorder<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: appUrl });
    await c.connect();
    try {
      await c.query('BEGIN');
      await asRecorder(c);
      const out = await fn(c);
      await c.query('COMMIT');
      return out;
    } catch (error) {
      await c.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      await c.end();
    }
  }
  // As another member (the owner) or with no context at all, rolled back.
  async function attemptAs(who: 'owner' | 'none', text: string, params: unknown[]): Promise<{ code: string | null }> {
    const c = new pg.Client({ connectionString: appUrl });
    await c.connect();
    try {
      await c.query('BEGIN');
      if (who === 'owner') await c.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [orgId, contextToken(users.owner, orgId)]);
      try {
        await c.query(text, params);
        return { code: null };
      } catch (error) {
        return { code: (error as { code?: string }).code ?? 'ERR' };
      }
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      await c.end();
    }
  }

  beforeAll(async () => {
    if (!ADMIN) return;
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
    runtime = new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands, ...meetingsCommands], queries: [...kernelQueries({ inboundDomain: null }), ...meetingsQueries] });
    for (const key of Object.keys(users) as Array<keyof typeof users>) users[key] = await upsertIdentity(db, { issuer: 'meetings-transcript-taint', subject: key, email: `${key}@meetings-transcript-taint.test`, name: null });
    orgId = (await createOrg(runtime, { type: 'user', userId: users.owner, aal: 'aal1' }, 'Dấu vết')).orgId;
    await admin(async (c) => {
      await c.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')`, [orgId, users.recorder]);
      await c.query(
        `INSERT INTO crove_meetings.meeting (org_id, id, title, language, started_at, ended_at, length_seconds, recorder_user_id, visibility, status, consent_method, consent_confirmed_by, consent_confirmed_at, consent_notice_version, audio_retention_date, text_retention_date)
         VALUES ($1, $2, 'Họp', 'vi', now(), now(), 60, $3, 'attendees', 'ready', 'told_at_start', $3, now(), '1.0', current_date + 30, current_date + 365)`,
        [orgId, meetingId, users.recorder],
      );
    });
  }, 300_000);

  afterAll(async () => {
    for (const pool of pools) await pool.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  const SEGMENT = (id: string, meeting: string, tainted: boolean, run: string | null) =>
    admin((c) =>
      c.query(`INSERT INTO crove_meetings.transcript_segment (org_id, id, meeting_id, start_seconds, end_seconds, text, stage, tainted, source_run_id) VALUES ($1, $2, $3, 0, 5, 'Lời của Vy', 'draft', $4, $5)`, [orgId, id, meeting, tainted, run]),
    );
  const state = async (id: string) => (await admin((c) => c.query<{ tainted: boolean; source_run_id: string | null; stage: string; text: string }>(`SELECT tainted, source_run_id, stage, text FROM crove_meetings.transcript_segment WHERE org_id = $1 AND id = $2`, [orgId, id]))).rows[0];

  it('a copied segment is born tainted with its run, and no update sets the mark or moves the run, a superuser included', async () => {
    const run = randomUUID();
    const copied = randomUUID();
    await SEGMENT(copied, meetingId, true, run);
    expect(await state(copied)).toMatchObject({ tainted: true, source_run_id: run });
    // The recorder inserts a tainted draft (the copy) but a published segment is never born tainted, by anybody.
    expect((await attempt('recorder', `INSERT INTO crove_meetings.transcript_segment (org_id, id, meeting_id, start_seconds, end_seconds, text, stage, tainted) VALUES ($1, $2, $3, 0, 1, 'x', 'draft', true)`, [orgId, randomUUID(), meetingId])).code).toBeNull();
    for (const who of ['recorder', 'superuser'] as const) {
      const res = await attempt(who, `INSERT INTO crove_meetings.transcript_segment (org_id, id, meeting_id, start_seconds, end_seconds, text, stage, tainted) VALUES ($1, $2, $3, 0, 1, 'x', 'published', true)`, [orgId, randomUUID(), meetingId]);
      expect(res.code, `${who} inserting a published tainted segment`).toBe('42501');
      expect(res.message).toMatch(/MEETINGS_DRAFT_NOT_REVIEWED/);
    }
    // A clear row is never turned tainted, and the run of a row never changes, whoever asks.
    const clear = randomUUID();
    await SEGMENT(clear, meetingId, false, null);
    for (const who of ['recorder', 'superuser'] as const) {
      const toTainted = await attempt(who, `UPDATE crove_meetings.transcript_segment SET tainted = true WHERE org_id = $1 AND id = $2`, [orgId, clear]);
      expect(toTainted.code, `${who} making a segment tainted`).toBe('42501');
      expect(toTainted.message).toMatch(who === 'recorder' ? /permission denied for table transcript_segment/ : /MEETINGS_TAINT_FORBIDDEN/);
      for (const set of [`source_run_id = NULL`, `source_run_id = '${randomUUID()}'`]) {
        const moved = await attempt(who, `UPDATE crove_meetings.transcript_segment SET ${set} WHERE org_id = $1 AND id = $2`, [orgId, copied]);
        expect(moved.code, `${who}: ${set}`).toBe('42501');
        expect(moved.message).toMatch(who === 'recorder' ? /permission denied for table transcript_segment/ : /MEETINGS_TAINT_FORBIDDEN/);
      }
    }
    expect(await state(copied)).toMatchObject({ tainted: true, source_run_id: run });
  });

  it('keeps the mark through the recorder\'s own corrections, and clears it only through draft_review for the recorder', async () => {
    const run = randomUUID();
    const id = randomUUID();
    await SEGMENT(id, meetingId, true, run);
    // The recorder may correct the text (the column grant allows it): the row stays tainted and keeps its run. Clearing the mark by hand, with or without a correction, is refused.
    await withRecorder((c) => c.query(`UPDATE crove_meetings.transcript_segment SET text = 'Lời đã sửa', corrected = true, updated_at = now() WHERE org_id = $1 AND id = $2`, [orgId, id]));
    expect(await state(id)).toMatchObject({ tainted: true, source_run_id: run, text: 'Lời đã sửa' });
    for (const text of [
      `UPDATE crove_meetings.transcript_segment SET tainted = false WHERE org_id = $1 AND id = $2`,
      `UPDATE crove_meetings.transcript_segment SET tainted = false, text = 'Đã sửa nữa' WHERE org_id = $1 AND id = $2`,
    ]) {
      const res = await attempt('recorder', text, [orgId, id]);
      expect(res.code).toBe('42501');
      expect(res.message).toMatch(/permission denied for table transcript_segment|MEETINGS_TAINT_FORBIDDEN/);
    }
    // Nobody else reviews: not another member, not a session with no context.
    // (The owner of draft_review, the migration role, is the one role that may clear the mark; in this test that is the superuser, so it is not tried here.)
    for (const who of ['owner', 'none'] as const) {
      expect((await attemptAs(who, `SELECT crove_meetings.draft_review($1::uuid, $2::uuid, $3::uuid[])`, [orgId, meetingId, [id]])).code, `${who} reviewing`).toBe('42501');
    }
    expect(await state(id)).toMatchObject({ tainted: true });
    // A segment of ANOTHER meeting of the org named with this meeting: refused, and that segment keeps its mark. An id that is no row is ignored.
    await admin((c) => c.query(`INSERT INTO crove_meetings.meeting (org_id, id, title, language, started_at, ended_at, length_seconds, recorder_user_id, visibility, status, consent_method, consent_confirmed_by, consent_confirmed_at, consent_notice_version, audio_retention_date, text_retention_date) VALUES ($1, $2, 'Họp', 'vi', now(), now(), 60, $3, 'attendees', 'ready', 'told_at_start', $3, now(), '1.0', current_date + 30, current_date + 365)`, [orgId, otherMeetingId, users.recorder]));
    const foreign = randomUUID();
    await SEGMENT(foreign, otherMeetingId, true, run);
    expect((await attempt('recorder', `SELECT crove_meetings.draft_review($1::uuid, $2::uuid, $3::uuid[])`, [orgId, meetingId, [id, foreign]])).code).toBe('42501');
    expect(await state(foreign)).toMatchObject({ tainted: true });
    expect(await state(id), 'the refused call changed nothing').toMatchObject({ tainted: true });
    // The recorder's review of the rows named: the mark goes, the run stays, and the count is the rows that lost it.
    const cleared = await withRecorder(async (c) => (await c.query<{ n: number }>(`SELECT crove_meetings.draft_review($1::uuid, $2::uuid, $3::uuid[]) AS n`, [orgId, meetingId, [id, randomUUID()]])).rows[0]?.n);
    expect(cleared).toBe(1);
    expect(await state(id)).toMatchObject({ tainted: false, source_run_id: run });
  });

  it('never publishes a draft segment that is still tainted, and publishes it once the recorder has reviewed it', async () => {
    const id = randomUUID();
    await SEGMENT(id, meetingId, true, randomUUID());
    for (const who of ['recorder', 'superuser'] as const) {
      const res = await attempt(who, `UPDATE crove_meetings.transcript_segment SET stage = 'published' WHERE org_id = $1 AND id = $2`, [orgId, id]);
      expect(res.code, `${who} publishing a tainted segment`).toBe('42501');
      expect(res.message).toMatch(who === 'recorder' ? /permission denied for table transcript_segment/ : /MEETINGS_DRAFT_NOT_REVIEWED/);
    }
    expect(await state(id)).toMatchObject({ stage: 'draft', tainted: true });
    await withRecorder((c) => c.query(`SELECT crove_meetings.draft_review($1::uuid, $2::uuid, $3::uuid[])`, [orgId, meetingId, [id]]));
    expect((await attempt('superuser', `UPDATE crove_meetings.transcript_segment SET stage = 'published' WHERE org_id = $1 AND id = $2`, [orgId, id])).code).toBeNull();
  });
});

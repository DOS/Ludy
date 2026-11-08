// SPDX-License-Identifier: AGPL-3.0-only
// The taint of a meeting's model-written text and the discard of a summary run on PostgreSQL 17 (issue #2580, ADR-0047 point 8, meetings plan M6 part B1):
// - `tainted` is set only by an insert; no update sets it, a superuser included; the tenant context (every user request) cannot change it at all, and only
//   crove_meetings.draft_review clears it, for the meeting's recorder alone, in a user context;
// - a draft that is still tainted is never published, whoever asks;
// - a meeting's removal cancels the live meetings.summary runs for it and deletes their result rows, a finished result that was never copied included.
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

suite('meeting taint and summary discard on PostgreSQL (#2580, ADR-0047)', () => {
  const dbName = `crove_test_meetings_taint_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  const pools: pg.Pool[] = [];
  let orgId = '';
  let runtime: Runtime;
  const users = { owner: '', recorder: '' };
  const meetingId = randomUUID();
  const ids = { result: randomUUID(), item: randomUUID() };

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
    for (const key of Object.keys(users) as Array<keyof typeof users>) users[key] = await upsertIdentity(db, { issuer: 'meetings-taint', subject: key, email: `${key}@meetings-taint.test`, name: null });
    orgId = (await createOrg(runtime, { type: 'user', userId: users.owner, aal: 'aal1' }, 'Dấu vết')).orgId;
    await admin(async (c) => {
      await c.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')`, [orgId, users.recorder]);
      await c.query(
        `INSERT INTO crove_meetings.meeting (org_id, id, title, language, started_at, ended_at, length_seconds, recorder_user_id, visibility, status, consent_method, consent_confirmed_by, consent_confirmed_at, consent_notice_version, audio_retention_date, text_retention_date)
         VALUES ($1, $2, 'Họp', 'vi', now(), now(), 60, $3, 'attendees', 'ready', 'told_at_start', $3, now(), '1.0', current_date + 30, current_date + 365)`,
        [orgId, meetingId, users.recorder],
      );
      await c.query(`INSERT INTO crove_meetings.meeting_result (org_id, id, meeting_id, summary, decisions, feature, tainted) VALUES ($1, $2, $3, 'Tóm tắt', '["a"]', 'meetings.summary', true)`, [orgId, ids.result, meetingId]);
      await c.query(`INSERT INTO crove_meetings.action_item (org_id, id, meeting_id, title, tainted) VALUES ($1, $2, $3, 'Việc', true)`, [orgId, ids.item, meetingId]);
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

  it('lets the recorder insert a tainted draft (the copy of a Vy result) but never turns an existing row tainted', async () => {
    expect((await attempt('recorder', `INSERT INTO crove_meetings.action_item (org_id, id, meeting_id, title, tainted) VALUES ($1, $2, $3, 'Từ Vy', true)`, [orgId, randomUUID(), meetingId])).code).toBeNull();
    for (const who of ['recorder', 'superuser'] as const) {
      // A clear row made tainted again, whoever asks, whatever else changes with it.
      const clear = randomUUID();
      await admin((c) => c.query(`INSERT INTO crove_meetings.action_item (org_id, id, meeting_id, title, tainted) VALUES ($1, $2, $3, 'Của tôi', false)`, [orgId, clear, meetingId]));
      const res = await attempt(who, `UPDATE crove_meetings.action_item SET tainted = true, title = 'Đã đổi' WHERE org_id = $1 AND id = $2`, [orgId, clear]);
      expect(res.code, `${who} making an item tainted`).toBe('42501');
      expect(res.message).toContain('MEETINGS_TAINT_FORBIDDEN');
      await admin((c) => c.query(`DELETE FROM crove_meetings.action_item WHERE org_id = $1 AND id = $2`, [orgId, clear]));
    }
    const clearResult = randomUUID();
    await admin(async (c) => {
      await c.query(`DELETE FROM crove_meetings.meeting_result WHERE org_id = $1 AND meeting_id = $2 AND stage = 'published'`, [orgId, meetingId]);
      await c.query(`INSERT INTO crove_meetings.meeting_result (org_id, id, meeting_id, summary, feature, stage, tainted) VALUES ($1, $2, $3, 'Của tôi', 'manual', 'published', false)`, [orgId, clearResult, meetingId]);
    });
    expect((await attempt('superuser', `UPDATE crove_meetings.meeting_result SET tainted = true WHERE org_id = $1 AND id = $2`, [orgId, clearResult])).code).toBe('42501');
    await admin((c) => c.query(`DELETE FROM crove_meetings.meeting_result WHERE org_id = $1 AND id = $2`, [orgId, clearResult]));
  });

  it('does not let the tenant context change the mark, and clears it only through draft_review for the recorder', async () => {
    // Directly, as the recorder: clearing is refused, with or without a change of the text.
    for (const text of [
      `UPDATE crove_meetings.action_item SET tainted = false WHERE org_id = $1 AND id = $2`,
      `UPDATE crove_meetings.action_item SET tainted = false, title = 'Việc đã sửa' WHERE org_id = $1 AND id = $2`,
    ]) {
      const res = await attempt('recorder', text, [orgId, ids.item]);
      expect(res.code).toBe('42501');
      expect(res.message).toContain('MEETINGS_TAINT_FORBIDDEN');
    }
    expect((await attempt('recorder', `UPDATE crove_meetings.meeting_result SET tainted = false, summary = 'Đã sửa' WHERE org_id = $1 AND id = $2`, [orgId, ids.result])).code).toBe('42501');
    // Through the recorder's review: one item, or the whole draft (the count is the rows that lost the mark).
    expect((await attempt('recorder', `SELECT crove_meetings.draft_review($1::uuid, $2::uuid, $3::uuid)`, [orgId, meetingId, ids.item])).rows).toBe(1);
    const all = await withRecorder(async (c) => (await c.query<{ n: number }>(`SELECT crove_meetings.draft_review($1::uuid, $2::uuid, NULL::uuid) AS n`, [orgId, meetingId])).rows[0]?.n);
    expect(all).toBe(2);
    // Nobody else reviews: not another member, and not a session with no context.
    for (const who of ['owner', 'none'] as const) {
      const res = await attemptAs(who, `SELECT crove_meetings.draft_review($1::uuid, $2::uuid, NULL::uuid)`, [orgId, meetingId]);
      expect(res.code, `${who} reviewing`).toBe('42501');
    }
    // Another org's id never matches.
    expect((await attempt('recorder', `SELECT crove_meetings.draft_review($1::uuid, $2::uuid, NULL::uuid)`, [randomUUID(), meetingId])).code).toBe('42501');
  });

  it('never publishes a draft that is still tainted, and publishes it once the recorder has reviewed it', async () => {
    const draftItem = randomUUID();
    const draftResult = randomUUID();
    await admin(async (c) => {
      await c.query(`DELETE FROM crove_meetings.meeting_result WHERE org_id = $1 AND meeting_id = $2 AND stage = 'draft'`, [orgId, meetingId]);
      await c.query(`INSERT INTO crove_meetings.action_item (org_id, id, meeting_id, title, tainted) VALUES ($1, $2, $3, 'Chưa đọc', true)`, [orgId, draftItem, meetingId]);
      await c.query(`INSERT INTO crove_meetings.meeting_result (org_id, id, meeting_id, summary, feature, tainted) VALUES ($1, $2, $3, 'Chưa đọc', 'meetings.summary', true)`, [orgId, draftResult, meetingId]);
    });
    for (const who of ['recorder', 'superuser'] as const) {
      for (const [table, id] of [['action_item', draftItem], ['meeting_result', draftResult]] as const) {
        const res = await attempt(who, `UPDATE crove_meetings.${table} SET stage = 'published' WHERE org_id = $1 AND id = $2`, [orgId, id]);
        expect(res.code, `${who} publishing a tainted ${table}`).toBe('42501');
        expect(res.message).toContain('MEETINGS_DRAFT_NOT_REVIEWED');
      }
    }
    await withRecorder((c) => c.query(`SELECT crove_meetings.draft_review($1::uuid, $2::uuid, NULL::uuid)`, [orgId, meetingId]));
    expect((await attempt('recorder', `UPDATE crove_meetings.action_item SET stage = 'published' WHERE org_id = $1 AND id = $2`, [orgId, draftItem])).rows).toBe(1);
  });

  it('cancels the live summary run of a meeting that is removed, and deletes its result (a finished one too)', async () => {
    const removed = randomUUID();
    await admin((c) =>
      c.query(
        `INSERT INTO crove_meetings.meeting (org_id, id, title, language, started_at, ended_at, length_seconds, recorder_user_id, visibility, status, consent_method, consent_confirmed_by, consent_confirmed_at, consent_notice_version, audio_retention_date, text_retention_date)
         VALUES ($1, $2, 'Họp sẽ xóa', 'vi', now(), now(), 60, $3, 'attendees', 'ready', 'told_at_start', $3, now(), '1.0', current_date + 30, current_date + 365)`,
        [orgId, removed, users.recorder],
      ),
    );
    const actor = { type: 'user' as const, userId: users.recorder, aal: 'aal1' as const };
    const live = await runtime.execute<{ runId: string }>('kernel.member_vy.run.start', { feature: 'meetings.summary', subjectType: 'meeting', subjectId: removed }, { actor, orgId });
    const stateOf = (runId: string) => admin((c) => c.query<{ run: string | null; error: string | null; results: string }>(
      `SELECT (SELECT status FROM crove_kernel.ai_run WHERE org_id = $1 AND id = $2) AS run, (SELECT error FROM crove_kernel.ai_run WHERE org_id = $1 AND id = $2) AS error,
              (SELECT count(*) FROM crove_kernel.member_vy_result WHERE org_id = $1 AND run_id = $2)::text AS results`,
      [orgId, runId],
    ));
    expect((await stateOf(live.runId)).rows[0]).toEqual({ run: 'running', error: null, results: '1' });
    await admin((c) => c.query(`DELETE FROM crove_meetings.meeting WHERE org_id = $1 AND id = $2`, [orgId, removed]));
    expect((await stateOf(live.runId)).rows[0]).toEqual({ run: 'cancelled', error: 'MEETING_REMOVED', results: '0' });
    // A finished result that was never copied goes too.
    const second = randomUUID();
    await admin((c) =>
      c.query(
        `INSERT INTO crove_meetings.meeting (org_id, id, title, language, started_at, ended_at, length_seconds, recorder_user_id, visibility, status, consent_method, consent_confirmed_by, consent_confirmed_at, consent_notice_version, audio_retention_date, text_retention_date)
         VALUES ($1, $2, 'Họp thứ hai', 'vi', now(), now(), 60, $3, 'attendees', 'ready', 'told_at_start', $3, now(), '1.0', current_date + 30, current_date + 365)`,
        [orgId, second, users.recorder],
      ),
    );
    const done = await runtime.execute<{ runId: string }>('kernel.member_vy.run.start', { feature: 'meetings.summary', subjectType: 'meeting', subjectId: second }, { actor, orgId });
    await runtime.execute('kernel.member_vy.result.store', { runId: done.runId, outcome: { status: 'ready', body: '{"summary":"x","decisions":[],"items":[],"dropped":0}' } }, { actor, orgId });
    await admin((c) => c.query(`DELETE FROM crove_meetings.meeting WHERE org_id = $1 AND id = $2`, [orgId, second]));
    expect((await stateOf(done.runId)).rows[0]?.results).toBe('0');
  });
});

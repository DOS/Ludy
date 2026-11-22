// SPDX-License-Identifier: AGPL-3.0-only
// Replacing a meeting's draft transcript is one after the other with a chapters save and a publish (#3916): the meeting row is held first, in the order those take it. On a real database: a replacement
// waits while another transaction holds the meeting row (a publish in flight, simulated by holding it), and goes on when that ends; a replacement of a meeting deleted meanwhile is a not-found answer;
// and many saves, publishes and replacements of one meeting at once end with every replacement whole (never a mix of two) and no database deadlock (a smoke check: the deadlock the order prevents
// was with a meeting delete and the erasure, which is argued from the lock order in the code and the PR).
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import { Runtime } from '@ludy/kernel-runtime';
import { meetingsCommands, meetingsQueries } from '@ludy/mod-meetings';
import { TEST_MANIFESTS } from './invariant/fixtures/manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('replacing the draft transcript holds the meeting row (#3916)', () => {
  const dbName = `crove_test_tlock_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  const pools: pg.Pool[] = [];
  let orgId = '';
  let runtime: Runtime;
  const users: Record<string, string> = {};
  const asUser = (who: string) => ({ type: 'user' as const, userId: users[who] as string, aal: 'aal1' as const });
  const exec = <O = unknown>(who: string, name: string, input: unknown) => runtime.execute<O>(name, input, { actor: asUser(who), orgId });
  const sqlAdmin = async <R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params: unknown[] = []) => {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await c.query<R>(text, params);
    } finally {
      await c.end();
    }
  };
  const lines = (...seconds: number[]) => seconds.map((s) => ({ startSeconds: s, endSeconds: s + 5, speakerLabel: 'Hà', text: `Dòng ${s}` }));
  const seconds = async (meetingId: string) => (await sqlAdmin<{ s: number }>(`SELECT start_seconds::int AS s FROM crove_meetings.transcript_segment WHERE meeting_id = $1 ORDER BY start_seconds`, [meetingId])).rows.map((r) => r.s);

  async function seedMeeting(): Promise<string> {
    const meetingId = randomUUID();
    await sqlAdmin(
      `INSERT INTO crove_meetings.meeting (org_id, id, title, language, started_at, ended_at, length_seconds, recorder_user_id, visibility, status, consent_method, consent_confirmed_by, consent_confirmed_at, consent_notice_version, audio_retention_date, text_retention_date)
       VALUES ($1, $2, 'Họp tuần', 'vi', '2026-11-10T03:00:00Z', '2026-11-10T04:00:00Z', 3600, $3, 'attendees', 'ready', 'told_at_start', $3, now(), '1.0', current_date + 30, current_date + 365)`,
      [orgId, meetingId, users.recorder],
    );
    await exec('recorder', 'meetings.transcript.draft_store', { meetingId, segments: lines(0, 10, 20) });
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
    await setRolePasswords(adminUrl, { ludy_app: 'test-app-pw', ludy_worker: 'test-worker-pw' });
    const url = new URL(adminUrl);
    url.username = 'ludy_app';
    url.password = 'test-app-pw';
    const pool = createPool({ connectionString: url.toString(), max: 12 });
    pools.push(pool);
    runtime = new Runtime(createDb(pool), { manifests: TEST_MANIFESTS }).register({
      commands: [...kernelCommands, ...meetingsCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...meetingsQueries],
    });
    for (const key of ['owner', 'recorder']) users[key] = await upsertIdentity(createDb(pool), { issuer: 'tlock', subject: key, email: `${key}@tlock.test`, name: null });
    orgId = (await createOrg(runtime, asUser('owner'), 'Khóa bản ghi')).orgId;
    await sqlAdmin(`INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')`, [orgId, users.recorder]);
  }, 300_000);

  afterAll(async () => {
    for (const pool of pools) await pool.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('waits while another transaction holds the meeting row, then replaces the lines', async () => {
    const meetingId = await seedMeeting();
    // A publish (or a chapters save) in flight holds the meeting row: simulated by holding it in a transaction of its own.
    const holder = new pg.Client({ connectionString: adminUrl });
    await holder.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT id FROM crove_meetings.meeting WHERE org_id = $1 AND id = $2 FOR NO KEY UPDATE`, [orgId, meetingId]);
      let done = false;
      const store = exec('recorder', 'meetings.transcript.draft_store', { meetingId, segments: lines(0, 40) }).then((r) => {
        done = true;
        return r;
      });
      // Not finished while the row is held, and the lines are still the old ones.
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(done).toBe(false);
      expect(await seconds(meetingId)).toEqual([0, 10, 20]);
      await holder.query('COMMIT');
      expect(await store).toEqual({ meetingId, stored: 2 });
      expect(await seconds(meetingId)).toEqual([0, 40]);
    } finally {
      await holder.query('ROLLBACK').catch(() => {});
      await holder.end();
    }
  });

  it('answers not-found when the meeting is deleted while the replacement waits for its row', async () => {
    const meetingId = await seedMeeting();
    const holder = new pg.Client({ connectionString: adminUrl });
    await holder.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT id FROM crove_meetings.meeting WHERE org_id = $1 AND id = $2 FOR NO KEY UPDATE`, [orgId, meetingId]);
      const store = exec('recorder', 'meetings.transcript.draft_store', { meetingId, segments: lines(0, 40) }).then(() => 'stored', (error: unknown) => (error as { code?: string }).code ?? 'ERR');
      await new Promise((resolve) => setTimeout(resolve, 400));
      // The meeting goes while the replacement waits (its lines and rows with it).
      await holder.query(`DELETE FROM crove_meetings.transcript_segment WHERE org_id = $1 AND meeting_id = $2`, [orgId, meetingId]);
      await holder.query(`DELETE FROM crove_meetings.meeting WHERE org_id = $1 AND id = $2`, [orgId, meetingId]);
      await holder.query('COMMIT');
      expect(await store).toBe('MEETING_NOT_FOUND');
    } finally {
      await holder.query('ROLLBACK').catch(() => {});
      await holder.end();
    }
  });

  it('ends with every replacement whole and no deadlock when saves, publishes and replacements of one meeting run at once', async () => {
    const meetingId = await seedMeeting();
    const settle = (p: Promise<unknown>) => p.then(() => 'ok', (error: unknown) => (error as { code?: string }).code ?? 'ERR');
    const work: Array<Promise<string>> = [];
    for (let i = 0; i < 8; i += 1) {
      work.push(settle(exec('recorder', 'meetings.transcript.draft_store', { meetingId, segments: lines(0, 10 + i, 20 + i) })));
      work.push(settle(exec('recorder', 'meetings.chapters.save', { meetingId, chapters: [{ title: `Mục ${i}`, startSeconds: 0 }] })));
      work.push(settle(exec('recorder', 'meetings.result.publish', { meetingId, confirmed: true })));
    }
    const results = await Promise.all(work);
    // Every call ends with a success or a domain refusal, never a deadlock or a serialization error from the database.
    expect(results.filter((r) => r !== 'ok' && !/^[A-Z][A-Z_]+$/.test(r)), JSON.stringify(results)).toEqual([]);
    expect(results.filter((r) => r === '40P01' || r === '40001')).toEqual([]);
    expect(results.filter((r) => r === 'ok').length).toBeGreaterThan(0);
    // The lines are one of the replacements whole, never a mix of two.
    const final = await seconds(meetingId);
    expect(final).toHaveLength(3);
    expect(final[0]).toBe(0);
    expect(final[1]! - 10).toBe(final[2]! - 20);
  });
});

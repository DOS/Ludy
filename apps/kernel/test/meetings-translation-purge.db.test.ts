// SPDX-License-Identifier: AGPL-3.0-only
// A removed member's machine translations of meetings go with their other Vy data (#3194, from #3184 and #3185; ADR-0049 decision 3): 30 days after a recorded removal of theirs, on the same sweep
// that purges their results and memory. A user who has only translations is listed as a former member; a translation made after the latest recorded removal makes that exit "not recorded" and
// nothing of theirs is removed; a member who is still in the org, one removed less than 30 days ago and another member's translations of the same meeting are never touched.
// The owner's counts name the translations and the live preview lines, and a removed recorder's preview lines go in the same purge, the meetings staying (#3584).
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import { Runtime } from '@ludy/kernel-runtime';
import { contextToken } from './invariant/fixtures/context-token.ts';
import { TEST_MANIFESTS } from './invariant/fixtures/manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite("a removed member's translations in the 30-day Vy purge (#3194)", () => {
  const dbName = `crove_test_translation_purge_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let workerUrl = '';
  let appUrl = '';
  const pools: pg.Pool[] = [];
  let orgId = '';
  let runtime: Runtime;
  const users = { owner: '', staying: '', gone: '', recent: '', back: '', rec: '', late: '' };
  const asMfa = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal2' as const, sessionId: randomUUID(), mfaAt: Math.floor(Date.now() / 1000) });

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
  // As the worker role, in the org's system context (the purge) or with no context at all (the sweep's list), committed.
  async function asWorker<T>(system: boolean, fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: workerUrl });
    await c.connect();
    try {
      await c.query('BEGIN');
      if (system) await c.query('SELECT ludy_kernel.enter_system_context($1::uuid)', [orgId]);
      const out = await fn(c);
      await c.query('COMMIT');
      return out;
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      await c.end();
    }
  }
  const purge = (user: string) => asWorker(true, async (c) => (await c.query<{ n: string }>('SELECT ludy_kernel.member_vy_member_data_purge($1::uuid, $2::uuid) AS n', [orgId, user])).rows[0]?.n);
  const due = () => asWorker(false, async (c) => (await c.query<{ org_id: string; user_id: string; recorded: boolean }>('SELECT * FROM ludy_kernel.member_vy_former_members_due(1000)')).rows.filter((r) => r.org_id === orgId));
  const translationsOf = async (user: string) => Number((await sqlAdmin<{ n: string }>('SELECT count(*)::text AS n FROM crove_meetings.translation WHERE org_id = $1 AND member_user_id = $2', [orgId, user])).rows[0]?.n);

  async function meeting(recorder: string = users.owner): Promise<string> {
    const id = randomUUID();
    await sqlAdmin(
      `INSERT INTO crove_meetings.meeting (org_id, id, title, language, started_at, ended_at, length_seconds, recorder_user_id, visibility, status, consent_method, consent_confirmed_by, consent_confirmed_at, consent_notice_version, audio_retention_date, text_retention_date)
       VALUES ($1, $2, 'Họp giao ban', 'vi', now() - interval '40 days', now() - interval '40 days' + interval '1 hour', 3600, $3, 'attendees', 'ready', 'told_at_start', $3, now(), '1.0', current_date + 20, current_date + 365)`,
      [orgId, id, recorder],
    );
    return id;
  }
  // A member's translation of a meeting: a summary one and a transcript one are two rows.
  const translate = (meetingId: string, user: string, kind: 'summary' | 'transcript', language: 'vi' | 'en' = 'en', ageDays = 0) =>
    sqlAdmin(
      `INSERT INTO crove_meetings.translation (org_id, meeting_id, member_user_id, kind, target_language, source_stage, source_hash, body, created_at)
       VALUES ($1, $2, $3, $4, $5, 'published', $6, '[]'::jsonb, now() - make_interval(days => $7::int))`,
      [orgId, meetingId, user, kind, language, 'a'.repeat(64), ageDays],
    );
  // The audit trail is append-only, so its trigger is set aside for this one statement.
  const backdateRemoval = (user: string, days: number) =>
    admin(async (c) => {
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query(`UPDATE ludy_kernel.audit_event SET occurred_at = occurred_at - make_interval(days => $3::int) WHERE org_id = $1 AND command = 'kernel.member.remove' AND target_id = $2`, [orgId, user, days]);
      await c.query('COMMIT');
    });

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
    workerUrl = login('ludy_worker', 'test-worker-pw');
    appUrl = login('ludy_app', 'test-app-pw');
    const appPool = createPool({ connectionString: appUrl, max: 4 });
    pools.push(appPool);
    const db = createDb(appPool);
    runtime = new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: null }) });
    for (const key of Object.keys(users) as Array<keyof typeof users>) users[key] = await upsertIdentity(db, { issuer: 'translation-purge', subject: key, email: `${key}@tpurge.test`, name: key });
    orgId = (await createOrg(runtime, { type: 'user', userId: users.owner, aal: 'aal1' }, 'Công ty Dịch')).orgId;
    for (const key of ['staying', 'gone', 'recent', 'back', 'rec', 'late'] as const) await sqlAdmin(`INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')`, [orgId, users[key]]);
  }, 300_000);

  afterAll(async () => {
    await Promise.all(pools.map((p) => p.end()));
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('purges the summary and transcript translations of a member removed over 30 days ago, with a record, and nothing of anyone else', async () => {
    const m1 = await meeting();
    const m2 = await meeting();
    // Made 40 days ago, before the removal (31 days ago for the one who is gone for good, today for the other).
    for (const user of [users.gone, users.staying, users.recent]) {
      await translate(m1, user, 'summary', 'en', 40);
      await translate(m1, user, 'transcript', 'en', 40);
    }
    await translate(m2, users.gone, 'summary', 'vi', 40);
    expect(await translationsOf(users.gone)).toBe(3);
    // Removed through the command (the audit trail has it), then the two who are gone: one 31 days ago, one now.
    for (const user of [users.gone, users.recent]) await runtime.execute('kernel.member.remove', { userId: user }, { actor: asMfa(users.owner), orgId });
    await backdateRemoval(users.gone, 31);
    // The sweep lists a user who has only translations, with the exit recorded: the one removed 31 days ago; the one removed now is not due yet.
    const listed = await due();
    expect(listed.map((r) => r.user_id)).toEqual([users.gone]);
    expect(listed[0]?.recorded).toBe(true);
    // Not a member who is still in the org, and not one removed less than 30 days ago.
    expect(await purge(users.staying)).toBe('0');
    expect(await purge(users.recent)).toBe('0');
    expect(await translationsOf(users.recent)).toBe(2);
    // The removed member's: all three rows go, counted.
    expect(await purge(users.gone)).toBe('3');
    expect(await translationsOf(users.gone)).toBe(0);
    // Everyone else's translations of the same meeting stay.
    expect(await translationsOf(users.staying)).toBe(2);
    expect(await translationsOf(users.recent)).toBe(2);
    expect((await due()).map((r) => r.user_id)).toEqual([]);
  });

  it('removes nothing of a user whose exit is not recorded, or whose translation is newer than their latest recorded exit', async () => {
    const m = await meeting();
    // A member gone with no removal in the audit trail at all: listed as not recorded, and the purge keeps the row.
    await sqlAdmin('DELETE FROM ludy_kernel.tenant_member WHERE org_id = $1 AND user_id = $2', [orgId, users.staying]);
    await translate(m, users.staying, 'summary', 'vi', 40);
    expect((await due()).find((r) => r.user_id === users.staying)).toMatchObject({ recorded: false });
    expect(await purge(users.staying)).toBe('0');
    expect(await translationsOf(users.staying)).toBeGreaterThan(0);
    // Removed long ago through the command, back in the org, translated again, and gone without a record: the translation is newer than the old removal, so nothing is purged.
    await runtime.execute('kernel.member.remove', { userId: users.back }, { actor: asMfa(users.owner), orgId });
    await backdateRemoval(users.back, 40);
    await sqlAdmin(`INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')`, [orgId, users.back]);
    await translate(m, users.back, 'summary');
    await sqlAdmin('DELETE FROM ludy_kernel.tenant_member WHERE org_id = $1 AND user_id = $2', [orgId, users.back]);
    expect((await due()).find((r) => r.user_id === users.back)).toMatchObject({ recorded: false });
    expect(await purge(users.back)).toBe('0');
    expect(await translationsOf(users.back)).toBe(1);
  });

  // The recorder's own preview lines of a meeting (tainted, the recorder's alone): made `ageDays` ago, one per sequence number.
  const liveLines = async (meetingId: string, count: number, ageDays: number) => {
    for (let seq = 0; seq < count; seq += 1) {
      await sqlAdmin(
        `INSERT INTO crove_meetings.live_line (org_id, meeting_id, seq, start_seconds, end_seconds, text, created_at) VALUES ($1, $2, $3, $4, $5, 'Bản nháp trực tiếp', now() - make_interval(days => $6::int))`,
        [orgId, meetingId, seq, seq * 15, seq * 15 + 15, ageDays],
      );
    }
  };
  const liveLinesIn = async (meetingId: string) => Number((await sqlAdmin<{ n: string }>('SELECT count(*)::text AS n FROM crove_meetings.live_line WHERE org_id = $1 AND meeting_id = $2', [orgId, meetingId])).rows[0]?.n);
  const counts = () =>
    asWorker(true, async (c) => (await c.query<{ member_user_id: string; translations: string; live_lines: string }>('SELECT * FROM crove_meetings.member_private_counts()')).rows);

  // The two meetings of the counting test, whose preview lines the purge test then removes (the two tests run in this order).
  let recMeeting = '';
  let ownerMeeting = '';

  it('counts a member\'s translations and the preview lines of the meetings they recorded, per member and as numbers only', async () => {
    const theirs = (recMeeting = await meeting(users.rec));
    const owners = (ownerMeeting = await meeting(users.owner));
    await translate(theirs, users.rec, 'summary', 'en', 40);
    await translate(owners, users.rec, 'transcript', 'en', 40);
    await liveLines(theirs, 2, 40);
    await liveLines(owners, 1, 40);
    const rows = await counts();
    const of = (user: string) => rows.find((r) => r.member_user_id === user);
    expect(of(users.rec)).toMatchObject({ translations: '2', live_lines: '2' });
    // The lines are counted for the member who recorded the meeting, not for whoever translated or attended it.
    expect(of(users.owner)).toMatchObject({ translations: '0', live_lines: '1' });
    expect(Object.keys(of(users.rec) ?? {}).sort()).toEqual(['live_lines', 'member_user_id', 'org_id', 'translations']);
  });

  it('answers the counts to the owner in a user context and to the worker in the system context, and to nobody else', async () => {
    const ask = async (enter: (c: pg.Client) => Promise<unknown>, url: string) => {
      const c = new pg.Client({ connectionString: url });
      await c.connect();
      try {
        await c.query('BEGIN');
        await enter(c);
        return (await c.query('SELECT * FROM crove_meetings.member_private_counts()')).rowCount;
      } catch (error) {
        return (error as { code?: string }).code;
      } finally {
        await c.query('ROLLBACK').catch(() => {});
        await c.end();
      }
    };
    const asUser = (userId: string) => (c: pg.Client) => c.query('SELECT ludy_kernel.enter_user_context($1::uuid, $2::text)', [orgId, contextToken(userId, orgId)]);
    expect(await ask(asUser(users.owner), appUrl)).toBeGreaterThan(0);
    // A plain member of the org (still one at this point), who sees only their own translations in the table, is refused the per-member numbers; so is a login with no context.
    expect(await ask(asUser(users.late), appUrl)).toBe('42501');
    expect(await ask(async () => undefined, appUrl)).toBe('42501');
    // The worker with no context, and the app login in the system context (the worker login only), are refused too.
    expect(await ask(async () => undefined, workerUrl)).toBe('42501');
    expect(await ask((c) => c.query('SELECT ludy_kernel.enter_system_context($1::uuid)', [orgId]), appUrl)).toBe('42501');
    expect(await ask((c) => c.query('SELECT ludy_kernel.enter_system_context($1::uuid)', [orgId]), workerUrl)).toBeGreaterThan(0);
  });

  it('removes a removed recorder\'s preview lines in the purge, keeps the meeting and the lines of other recorders, and a line newer than the last recorded exit stops it', async () => {
    const theirs = recMeeting;
    const owners = ownerMeeting;
    const before = await liveLinesIn(theirs);
    expect(before).toBe(2);
    await runtime.execute('kernel.member.remove', { userId: users.rec }, { actor: asMfa(users.owner), orgId });
    // Less than 30 days after the removal: nothing, and the user is not listed yet.
    expect(await purge(users.rec)).toBe('0');
    expect((await due()).find((r) => r.user_id === users.rec)).toBeUndefined();
    await backdateRemoval(users.rec, 31);
    expect((await due()).find((r) => r.user_id === users.rec)).toMatchObject({ recorded: true });
    // Their translations (2) and their preview lines (2) go together, counted; the meetings stay and so does the owner's own line.
    expect(await purge(users.rec)).toBe('4');
    expect(await liveLinesIn(theirs)).toBe(0);
    expect(await liveLinesIn(owners)).toBe(1);
    expect(Number((await sqlAdmin<{ n: string }>('SELECT count(*)::text AS n FROM crove_meetings.meeting WHERE org_id = $1 AND id = $2', [orgId, theirs])).rows[0]?.n)).toBe(1);
    expect((await due()).find((r) => r.user_id === users.rec)).toBeUndefined();
    // A recorder removed long ago, back, who recorded again and is gone with no record: the new line is newer than the old removal, so nothing is removed.
    await runtime.execute('kernel.member.remove', { userId: users.late }, { actor: asMfa(users.owner), orgId });
    await backdateRemoval(users.late, 40);
    await sqlAdmin(`INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')`, [orgId, users.late]);
    const later = await meeting(users.late);
    await liveLines(later, 1, 0);
    await sqlAdmin('DELETE FROM ludy_kernel.tenant_member WHERE org_id = $1 AND user_id = $2', [orgId, users.late]);
    expect((await due()).find((r) => r.user_id === users.late)).toMatchObject({ recorded: false });
    expect(await purge(users.late)).toBe('0');
    expect(await liveLinesIn(later)).toBe(1);
  });
});

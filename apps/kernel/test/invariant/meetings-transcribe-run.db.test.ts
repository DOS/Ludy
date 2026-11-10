// SPDX-License-Identifier: AGPL-3.0-only
// The recorder's transcription run as the recorder's own Vy (#2578, M4b, ADR-0049 decision 8): what the database and the commands hold, whatever the worker or a
// screen does. Part of the invariant suite; it imports code under test, never helpers from outside test/invariant/. Set CROVE_TEST_ADMIN_URL to a superuser
// URL; each run makes its own database.
//   - crove_meetings.audio_for_member_vy answers ids and the wrapped key of ONE meeting, only in a member-scoped context whose own live run's result row names
//     that meeting and whose member is that meeting's recorder and active; the app login, a user, the system and a run of another meeting or member get a refusal;
//     a result that is no longer running, a run that is not live and a member who left are refused; it is executable by the worker login alone.
//   - The member-scoped context writes no meeting table: the recorder's own action copies the result, and only the recorder can; a non-recorder, a reader who is
//     not the recorder and a former member are refused.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime, memberVyRuntime } from '@crove/kernel-runtime';
import { meetingsCommands, meetingsQueries, setTranscribeEnabled, encodeTranscriptResult } from '@crove/mod-meetings';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';
import { contextToken } from './fixtures/context-token.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const FN = 'crove_meetings.audio_for_member_vy(uuid,uuid)';
const TRIGGER_FN = 'crove_meetings.meeting_discard_transcribe()';

suite('the recorder\'s transcription run (#2578)', () => {
  const dbName = `crove_test_inv_transcribe_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let workerUrl = '';
  const pools: pg.Pool[] = [];
  let app: Runtime;
  let worker: Runtime;
  let orgId = '';
  const users: Record<string, string> = {};
  const meetings: Record<string, string> = {};
  const runs: Record<string, { agentId: string; runId: string }> = {};
  const asUser = (who: string) => ({ type: 'user' as const, userId: users[who] as string, aal: 'aal1' as const });
  const vy = (who: string) => memberVyRuntime(worker, orgId, runs[who] as { agentId: string; runId: string });
  const code = (promise: Promise<unknown>) => promise.then(() => null, (error: unknown) => (error as { code?: string; message?: string }).code ?? (error as Error).message);

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }

  async function seedMeeting(recorder: string): Promise<string> {
    const id = randomUUID();
    await admin(async (c) => {
      await c.query(
        `INSERT INTO crove_meetings.meeting (org_id, id, title, language, started_at, ended_at, length_seconds, recorder_user_id, visibility, status, consent_method, consent_confirmed_by, consent_confirmed_at, consent_notice_version, audio_retention_date, text_retention_date)
         VALUES ($1, $2, 'Họp', 'vi', now(), now() + interval '10 minutes', 600, $3, 'attendees', 'ready', 'told_at_start', $3, now(), '1.0', current_date + 30, current_date + 365)`,
        [orgId, id, users[recorder]],
      );
      const sha = randomUUID().replaceAll('-', '').padEnd(64, '0');
      const file = randomUUID();
      await c.query(`INSERT INTO crove_kernel.file (org_id, id, sha256, storage_key, filename, content_type, size_bytes, source) VALUES ($1, $2, $3, $4, 'a.opus', 'audio/ogg', 100, 'meeting_audio')`, [orgId, file, sha, `org/${orgId}/${sha}`]);
      await c.query(`INSERT INTO crove_meetings.audio_segment (org_id, id, meeting_id, file_id, segment_order, start_offset_seconds, length_seconds) VALUES ($1, $2, $3, $4, 0, 0, 600)`, [orgId, randomUUID(), id, file]);
      await c.query(`INSERT INTO crove_meetings.media_key (org_id, id, meeting_id, key_id, kind, wrapped_key) VALUES ($1, $2, $3, 'k1', 'audio', $4)`, [orgId, randomUUID(), id, Buffer.alloc(60, 7)]);
    });
    return id;
  }

  // A run of `who`'s Vy for `meeting`, started by the member's own command as the app does.
  async function startRun(who: string, meeting: string): Promise<{ agentId: string; runId: string }> {
    const started = await app.execute<{ runId: string }>('kernel.member_vy.run.start', { feature: 'meetings.transcribe', subjectType: 'meeting', subjectId: meeting }, { actor: asUser(who), orgId });
    const agent = await admin((c) => c.query<{ id: string }>(`SELECT id FROM crove_kernel.agent WHERE org_id = $1 AND member_user_id = $2 AND kind = 'member_vy'`, [orgId, users[who]]));
    return { agentId: agent.rows[0]?.id as string, runId: started.runId };
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
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });
    const login = (username: string, password: string) => {
      const url = new URL(adminUrl);
      url.username = username;
      url.password = password;
      return url.toString();
    };
    appUrl = login('crove_app', 'test-app-pw');
    workerUrl = login('crove_worker', 'test-worker-pw');
    const appPool = createPool({ connectionString: appUrl, max: 3 });
    const workerPool = createPool({ connectionString: workerUrl, max: 4 });
    pools.push(appPool, workerPool);
    setTranscribeEnabled(true);
    const register = { commands: [...kernelCommands, ...meetingsCommands], queries: [...kernelQueries({ inboundDomain: null }), ...meetingsQueries] };
    app = new Runtime(createDb(appPool), { manifests: TEST_MANIFESTS }).register(register);
    worker = new Runtime(createDb(workerPool), { manifests: TEST_MANIFESTS }).register(register);
    for (const key of ['owner', 'recorder', 'other', 'reader', 'former', 'extra', 'gone']) {
      users[key] = await upsertIdentity(createDb(appPool), { issuer: 'inv-transcribe', subject: key, email: `${key}@inv-transcribe.test`, name: null });
    }
    orgId = (await createOrg(app, { type: 'user', userId: users.owner as string, aal: 'aal1' }, 'Invariant transcribe')).orgId;
    await admin((c) => c.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member'), ($1, $4, 'member'), ($1, $5, 'member'), ($1, $6, 'member'), ($1, $7, 'member')`, [orgId, users.recorder, users.other, users.reader, users.former, users.extra, users.gone]));
    meetings.mine = await seedMeeting('recorder');
    meetings.mineToo = await seedMeeting('recorder');
    meetings.theirs = await seedMeeting('other');
    meetings.formers = await seedMeeting('former');
    meetings.extras = await seedMeeting('extra');
    meetings.gones = await seedMeeting('gone');
    await admin((c) => c.query(`INSERT INTO crove_meetings.meeting_reader (org_id, id, meeting_id, user_id) VALUES ($1, $2, $3, $4), ($1, $5, $3, $6)`, [orgId, randomUUID(), meetings.mine, users.reader, randomUUID(), users.other]));
    runs.recorder = await startRun('recorder', meetings.mine as string);
    runs.other = await startRun('other', meetings.theirs as string);
    runs.former = await startRun('former', meetings.formers as string);
    runs.extra = await startRun('extra', meetings.extras as string);
  }, 300_000);

  afterAll(async () => {
    for (const pool of pools) await pool.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('answers ids and the wrapped key of the run\'s own meeting, to the recorder\'s own live run', async () => {
    const out = await vy('recorder').execute<{ keyId: string; segments: Array<{ lengthSeconds: number }> }>('kernel.member_vy.meeting_audio.open', { meetingId: meetings.mine });
    expect(out.keyId).toBe('k1');
    expect(out.segments.map((s) => s.lengthSeconds)).toEqual([600]);
    // The read is audited by ids and a count: the run, the meeting, how many files; no key material, no storage key.
    const audit = await admin((c) => c.query<{ t: string }>(`SELECT detail::text AS t FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'kernel.member_vy.meeting_audio.open' LIMIT 1`, [orgId]));
    expect(JSON.parse(audit.rows[0]?.t ?? '{}')).toMatchObject({ runId: runs.recorder?.runId, subjectId: meetings.mine, count: 1 });
    expect(audit.rows[0]?.t).not.toMatch(/k1|org\//);
  });

  it('refuses another meeting of the same recorder, another member\'s meeting, and the run of a member who is not that meeting\'s recorder', async () => {
    expect(await code(vy('recorder').execute('kernel.member_vy.meeting_audio.open', { meetingId: meetings.mineToo }))).toBe('FORBIDDEN');
    expect(await code(vy('recorder').execute('kernel.member_vy.meeting_audio.open', { meetingId: meetings.theirs }))).toBe('FORBIDDEN');
    expect(await code(vy('other').execute('kernel.member_vy.meeting_audio.open', { meetingId: meetings.mine }))).toBe('FORBIDDEN');
  });

  // A client on the worker login, entered as the recorder's Vy run in a READ ONLY transaction (the entry then takes no lock on the member's row, so the test can change
  // the member, the run or the org from another connection AFTER a successful entry); the definer is then called and the message of its refusal is returned.
  async function afterEntry(who: string, meeting: string, mutate: () => Promise<unknown>): Promise<string | null> {
    const run = runs[who] as { agentId: string; runId: string };
    const c = new pg.Client({ connectionString: workerUrl });
    await c.connect();
    try {
      await c.query('BEGIN READ ONLY');
      await c.query('SELECT crove_kernel.enter_member_vy_context($1::uuid, $2::uuid, $3::uuid)', [orgId, run.agentId, run.runId]);
      await mutate();
      await c.query(`SELECT * FROM ${FN.replace('(uuid,uuid)', '')}($1::uuid, $2::uuid)`, [orgId, meeting]);
      return null;
    } catch (error) {
      return (error as pg.DatabaseError).code === '42501' ? (error as Error).message : `unexpected: ${(error as Error).message}`;
    } finally {
      await c.end();
    }
  }
  const sqlAdmin = (text: string, params: unknown[] = []) => admin((c) => c.query(text, params));
  // An expired run needs both timestamps moved (CHECK expires_at > started_at); the member_vy 4-hour bound (#2856) forbids moving the start, so triggers are off for this one statement.
  const expireRun = (runId: string) =>
    admin((c) => c.query(`SET LOCAL session_replication_role = replica; UPDATE crove_kernel.ai_run SET started_at = now() - interval '2 hours', expires_at = now() - interval '1 minute' WHERE org_id = '${orgId}' AND id = '${runId}'`));

  it('is executable by the worker login alone: every crove_ role, the trigger function included, gets a real 42501 except the worker on the audio door', async () => {
    const info = await admin((c) => c.query<{ definer: boolean; config: string[]; rettype: string }>(`SELECT prosecdef AS definer, proconfig AS config, prorettype::regtype::text AS rettype FROM pg_proc WHERE oid = '${FN}'::regprocedure`));
    expect(info.rows[0]).toMatchObject({ definer: true, config: ['search_path=pg_catalog, pg_temp'] });
    const trigger = await admin((c) => c.query<{ definer: boolean; config: string[] }>(`SELECT prosecdef AS definer, proconfig AS config FROM pg_proc WHERE oid = '${TRIGGER_FN}'::regprocedure`));
    expect(trigger.rows[0]).toEqual({ definer: true, config: ['search_path=pg_catalog, pg_temp'] });
    const roles = (await admin((c) => c.query<{ rolname: string }>(`SELECT rolname FROM pg_roles WHERE rolname LIKE 'crove\\_%' AND NOT rolsuper ORDER BY 1`))).rows.map((r) => r.rolname);
    expect(roles, 'the matrix covers the roles of the stack').toEqual(expect.arrayContaining(['crove_app', 'crove_tenant', 'crove_worker', 'crove_definer_tenant']));
    for (const role of ['public', ...roles]) {
      const privilege = await admin((c) => c.query<{ door: boolean; trig: boolean }>(`SELECT has_function_privilege($1, '${FN}', 'EXECUTE') AS door, has_function_privilege($1, '${TRIGGER_FN}', 'EXECUTE') AS trig`, [role]));
      expect(privilege.rows[0], `privileges of ${role}`).toEqual({ door: role === 'crove_worker', trig: false });
    }
    // A real call as every role: the connection is the superuser's, SET ROLE makes the role the one that is asked for EXECUTE.
    for (const role of roles) {
      const c = new pg.Client({ connectionString: adminUrl });
      await c.connect();
      try {
        const attempt = async (text: string, params: unknown[] = []) => {
          await c.query('BEGIN');
          await c.query(`SET LOCAL ROLE ${role}`);
          try {
            await c.query(text, params);
            return null;
          } catch (error) {
            return (error as pg.DatabaseError).code;
          } finally {
            await c.query('ROLLBACK');
          }
        };
        expect(await attempt(`SELECT crove_meetings.meeting_discard_transcribe()`), `${role} calls the trigger function`).toBe('42501');
        if (role !== 'crove_worker') expect(await attempt(`SELECT * FROM crove_meetings.audio_for_member_vy($1::uuid, $2::uuid)`, [orgId, meetings.mine]), `${role} calls the audio door`).toBe('42501');
      } finally {
        await c.end();
      }
    }
  });

  it('refuses, with the function\'s own codes, the system context, no context and a real user context', async () => {
    const door = `SELECT * FROM crove_meetings.audio_for_member_vy($1::uuid, $2::uuid)`;
    const as = async (url: string, enter: ((c: pg.Client) => Promise<unknown>) | null): Promise<string | null> => {
      const c = new pg.Client({ connectionString: url });
      await c.connect();
      try {
        await c.query('BEGIN');
        if (enter) await enter(c);
        await c.query(door, [orgId, meetings.mine]);
        return null;
      } catch (error) {
        return `${(error as pg.DatabaseError).code} ${(error as Error).message}`;
      } finally {
        await c.end();
      }
    };
    expect(await as(workerUrl, (c) => c.query('SELECT crove_kernel.enter_system_context($1::uuid)', [orgId]))).toBe('42501 MEETINGS_RUN_REQUIRED');
    expect(await as(workerUrl, null)).toBe('42501 MEETINGS_RUN_REQUIRED');
    // A real user context of the recorder, entered on the app login (the one a user's request runs on): the login has no EXECUTE, so the database answers 42501 itself.
    const asUser = await as(appUrl, (c) => c.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [orgId, contextToken(users.recorder as string, orgId)]));
    expect(asUser).toMatch(/^42501 permission denied for function audio_for_member_vy/);
  });

  it('refuses after a successful entry, in the definer\'s own checks: a run that is succeeded, cancelled, expired or whose result is no longer running', async () => {
    const meeting = meetings.extras as string;
    const runOf = (who: string) => (runs[who] as { runId: string }).runId;
    const cases: Array<{ name: string; mutate: () => Promise<unknown>; expected: string }> = [
      { name: 'succeeded', mutate: () => sqlAdmin(`UPDATE crove_kernel.ai_run SET status = 'succeeded', finished_at = now() WHERE org_id = $1 AND id = $2`, [orgId, runOf('extra')]), expected: 'MEETINGS_RUN_REQUIRED' },
      { name: 'cancelled', mutate: () => sqlAdmin(`UPDATE crove_kernel.ai_run SET status = 'cancelled', finished_at = now(), error = 'TEST' WHERE org_id = $1 AND id = $2`, [orgId, runOf('extra')]), expected: 'MEETINGS_RUN_REQUIRED' },
      { name: 'expired', mutate: () => expireRun(runOf('extra')), expected: 'MEETINGS_RUN_REQUIRED' },
      { name: 'result failed', mutate: () => sqlAdmin(`UPDATE crove_kernel.member_vy_result SET status = 'failed', body = NULL, error_code = 'TEST' WHERE org_id = $1 AND run_id = $2`, [orgId, runOf('extra')]), expected: 'MEETINGS_RUN_REQUIRED' },
    ];
    for (const item of cases) {
      runs.extra = await startRun('extra', meeting);
      expect(await afterEntry('extra', meeting, async () => undefined), `${item.name}: a control, nothing changed`).toBeNull();
      expect(await afterEntry('extra', meeting, item.mutate), item.name).toBe(item.expected);
    }
  });

  it('refuses after a successful entry when the member, their rights or the org changed: vy.use revoked, demoted to viewer, removed', async () => {
    const meeting = meetings.gones as string;
    runs.gone = await startRun('gone', meeting);
    const member = [orgId, users.gone];
    expect(await afterEntry('gone', meeting, async () => undefined), 'a control').toBeNull();
    expect(await afterEntry('gone', meeting, () => sqlAdmin(`INSERT INTO crove_kernel.member_permission_override (org_id, user_id, permission, allowed, set_by) VALUES ($1, $2, 'vy.use', false, $3)`, [...member, users.owner])), 'vy.use revoked').toBe('MEETINGS_NOT_RECORDER');
    await sqlAdmin(`DELETE FROM crove_kernel.member_permission_override WHERE org_id = $1 AND user_id = $2`, member);
    expect(await afterEntry('gone', meeting, () => sqlAdmin(`UPDATE crove_kernel.tenant_member SET role = 'viewer' WHERE org_id = $1 AND user_id = $2`, member)), 'demoted to viewer').toBe('MEETINGS_NOT_RECORDER');
    await sqlAdmin(`UPDATE crove_kernel.tenant_member SET role = 'member' WHERE org_id = $1 AND user_id = $2`, member);
    expect(await afterEntry('gone', meeting, async () => undefined), 'a control after the restores').toBeNull();
    expect(await afterEntry('gone', meeting, () => sqlAdmin(`DELETE FROM crove_kernel.tenant_member WHERE org_id = $1 AND user_id = $2`, member)), 'member removed').toBe('MEETINGS_NOT_RECORDER');
  });

  it('refuses after a successful entry once the meeting\'s audio retention date is reached (#2863)', async () => {
    const meeting = meetings.extras as string;
    runs.extra = await startRun('extra', meeting);
    const until = (await sqlAdmin(`SELECT audio_retention_date::text AS d FROM crove_meetings.meeting WHERE org_id = $1 AND id = $2`, [orgId, meeting])).rows[0]?.d as string;
    expect(await afterEntry('extra', meeting, async () => undefined), 'a control, a date still ahead').toBeNull();
    expect(await afterEntry('extra', meeting, () => sqlAdmin(`UPDATE crove_meetings.meeting SET audio_retention_date = (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date WHERE org_id = $1 AND id = $2`, [orgId, meeting])), 'on the date').toBe('MEETINGS_AUDIO_EXPIRED');
    await sqlAdmin(`UPDATE crove_meetings.meeting SET audio_retention_date = $3 WHERE org_id = $1 AND id = $2`, [orgId, meeting, until]);
    expect(await afterEntry('extra', meeting, async () => undefined), 'a control after the restore').toBeNull();
  });

  it('refuses the admit (run.check) of a run whose member was demoted to viewer, by the runtime before any handler (#2863 item 6)', async () => {
    const meeting = meetings.extras as string;
    runs.extra = await startRun('extra', meeting);
    const member = [orgId, users.extra];
    expect(await code(vy('extra').query('kernel.member_vy.run.check', {})), 'a control').toBeNull();
    await sqlAdmin(`UPDATE crove_kernel.tenant_member SET role = 'viewer' WHERE org_id = $1 AND user_id = $2`, member);
    try {
      expect(await code(vy('extra').query('kernel.member_vy.run.check', {})), 'demoted to viewer').toBe('FORBIDDEN');
    } finally {
      await sqlAdmin(`UPDATE crove_kernel.tenant_member SET role = 'member' WHERE org_id = $1 AND user_id = $2`, member);
    }
  });

  it('refuses at the entry, with the runtime\'s own codes, a member who left, a revoked vy.use and an expired run', async () => {
    // The runtime's refusals before the definer is reached, each by its exact code: the former member's membership ends, and another member's run expires.
    await sqlAdmin(`DELETE FROM crove_kernel.tenant_member WHERE org_id = $1 AND user_id = $2`, [orgId, users.former]);
    await expireRun(runs.other?.runId as string);
    const enterError = async (who: string): Promise<string> => {
      const run = runs[who] as { agentId: string; runId: string };
      const c = new pg.Client({ connectionString: workerUrl });
      await c.connect();
      try {
        await c.query('BEGIN');
        await c.query('SELECT crove_kernel.enter_member_vy_context($1::uuid, $2::uuid, $3::uuid)', [orgId, run.agentId, run.runId]);
        return 'entered';
      } catch (error) {
        return `${(error as pg.DatabaseError).code} ${(error as Error).message}`;
      } finally {
        await c.end();
      }
    };
    // The database's own words at the entry, and the runtime's code for them.
    expect(await enterError('former')).toBe('42501 MEMBER_NOT_ACTIVE');
    expect(await enterError('gone')).toBe('42501 MEMBER_NOT_ACTIVE');
    expect(await enterError('other')).toBe('42501 AGENT_RUN_NOT_LIVE');
    expect(await code(vy('former').execute('kernel.member_vy.meeting_audio.open', { meetingId: meetings.formers }))).toBe('FORBIDDEN');
    expect(await code(vy('gone').execute('kernel.member_vy.meeting_audio.open', { meetingId: meetings.gones }))).toBe('FORBIDDEN');
    expect(await code(vy('other').execute('kernel.member_vy.meeting_audio.open', { meetingId: meetings.theirs }))).toBe('AGENT_RUN_NOT_LIVE');
  });

  it('refuses another org\'s id, with the right run entered, and a meeting that is not the run\'s subject', async () => {
    runs.extra = await startRun('extra', meetings.extras as string);
    expect(await code(vy('extra').execute('kernel.member_vy.meeting_audio.open', { meetingId: meetings.extras }))).toBeNull();
    const run = runs.extra as { agentId: string; runId: string };
    const c = new pg.Client({ connectionString: workerUrl });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT crove_kernel.enter_member_vy_context($1::uuid, $2::uuid, $3::uuid)', [orgId, run.agentId, run.runId]);
      await expect(c.query('SELECT * FROM crove_meetings.audio_for_member_vy($1::uuid, $2::uuid)', [randomUUID(), meetings.extras])).rejects.toThrow('MEETINGS_RUN_REQUIRED');
    } finally {
      await c.end();
    }
    expect(await code(vy('extra').execute('kernel.member_vy.meeting_audio.open', { meetingId: meetings.mine }))).toBe('FORBIDDEN');
  });

  it('writes no meeting table in the member-scoped context: the transcript draft is the recorder\'s own copy, and only the recorder\'s', async () => {
    const meetingId = meetings.mineToo as string;
    const fresh = await startRun('recorder', meetingId);
    runs.recorder = fresh;
    const body = encodeTranscriptResult([{ startSeconds: 0, endSeconds: 4, speakerLabel: 'Người nói 1', text: 'xin chào' }]);
    await vy('recorder').execute('kernel.member_vy.result.store', { runId: fresh.runId, outcome: { status: 'ready', body } });
    const drafts = () => admin((c) => c.query<{ n: string }>(`SELECT count(*)::text AS n FROM crove_meetings.transcript_segment WHERE org_id = $1 AND meeting_id = $2`, [orgId, meetingId]));
    expect((await drafts()).rows[0]?.n).toBe('0');
    // A non-recorder who cannot read the meeting, a reader who is not the recorder, the owner and a former member: refused, nothing copied.
    for (const [who, expected] of [['other', 'MEETING_NOT_FOUND'], ['reader', 'MEETING_NOT_FOUND'], ['owner', 'MEETING_NOT_FOUND'], ['former', 'NOT_A_MEMBER']] as const) {
      expect(await code(app.execute('meetings.transcript.copy_result', { meetingId, runId: fresh.runId }, { actor: asUser(who), orgId })), who).toBe(expected);
    }
    expect((await drafts()).rows[0]?.n).toBe('0');
    // A member-scoped context cannot run the copy: it is no command of the kernel's own member_vy namespace.
    expect(await code(vy('recorder').execute('meetings.transcript.copy_result', { meetingId, runId: fresh.runId }))).toBe('FORBIDDEN');
    expect((await drafts()).rows[0]?.n).toBe('0');
    await app.execute('meetings.transcript.copy_result', { meetingId, runId: fresh.runId }, { actor: asUser('recorder'), orgId });
    expect((await drafts()).rows[0]?.n).toBe('1');
  });
});

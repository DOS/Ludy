// SPDX-License-Identifier: AGPL-3.0-only
// Transcription as the recorder's own Vy on a real database (#2578, M4b): the recorder starts the run, the worker runs it in the recorder's member-scoped
// context against a fake provider, and the recorder's own action copies the result into the draft. Only the recorder starts and copies; a non-recorder and
// a former member are refused; the call is metered by audio length and charged to the recorder's Vy; a kill switch, a spent budget and the deployment's
// own off switch refuse cleanly and leave the meeting working. The database-level rules of the audio door are in invariant/meetings-transcribe-run.db.test.ts.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import {
  BlobNotFoundError,
  DomainError,
  Runtime,
  encryptBlobBuffer,
  sha256Hex,
  wrapMediaKeyWithSubkey,
  type BlobStore,
  type CredentialBroker,
} from '@crove/kernel-runtime';
import { meetingsCommands, meetingsQueries, setTranscribeBroker, setTranscribeEnabled } from '@crove/mod-meetings';
import { runMeetingsTranscribe, type MeetingsTranscribeDeps } from '../src/meetings-transcribe.ts';
import { mediaMeasurerFor, type MediaMeasurer } from '../src/meetings-measure.ts';
import { fakeMediaMeasurer } from './fake-media.ts';
import { TEST_MANIFESTS } from './invariant/fixtures/manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

class MemoryStore implements BlobStore {
  readonly objects = new Map<string, Uint8Array>();
  async put(key: string, bytes: Uint8Array): Promise<string> {
    this.objects.set(key, new Uint8Array(bytes));
    return 'content:' + sha256Hex(bytes);
  }
  async get(key: string): Promise<Uint8Array> {
    const bytes = this.objects.get(key);
    if (!bytes) throw new BlobNotFoundError(key);
    return bytes;
  }
  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

suite('transcription as the recorder\'s own Vy (#2578, M4b)', () => {
  const dbName = `crove_test_transcribe_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  const pools: pg.Pool[] = [];
  let orgId = '';
  let app: Runtime;
  let worker: Runtime;
  const users: Record<string, string> = {};
  const store = new MemoryStore();
  const broker = {
    keyId: 'k1-transcribe-test',
    keyIds: ['k1-transcribe-test'],
    derive: (purpose: string) => createHash('sha256').update(`test-secret:${purpose}`).digest(),
    deriveKey: (keyId: string, purpose: string) => createHash('sha256').update(`test-secret:${keyId}:${purpose}`).digest(),
  } as unknown as CredentialBroker;
  let providerCalls = 0;
  let afterFirstCall: (() => Promise<void>) | null = null;
  const provider: MeetingsTranscribeDeps['provider'] = {
    baseURL: 'http://provider.test/v1',
    model: 'whisper-test',
    fetch: (async () => {
      providerCalls += 1;
      if (afterFirstCall) {
        const hook = afterFirstCall;
        afterFirstCall = null;
        await hook();
      }
      return new Response(JSON.stringify({ text: 'xin chao', segments: [{ start: 0, end: 5, text: `xin chào ${providerCalls}` }, { start: 5, end: 9, text: 'tạm biệt' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch,
  };
  const deps = (measurer: MediaMeasurer = fakeMediaMeasurer(600)): MeetingsTranscribeDeps => ({ runtime: worker, store, broker, measurer, provider, price: { inputPerMTok: '0', outputPerMTok: '0', audioPerMinute: '0.5' } });
  const asUser = (who: string) => ({ type: 'user' as const, userId: users[who] as string, aal: 'aal1' as const });

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }

  // A meeting recorded by `who` with two sealed 10 minute audio chunks, as the media sandbox and the claim step leave it.
  async function seedMeeting(who: string): Promise<string> {
    const meetingId = randomUUID();
    const keyId = 'k1-transcribe-test';
    const dataKey = randomBytes(32);
    const binding = { orgId, meetingId, kind: 'audio' as const };
    const subkey = (broker.deriveKey as (k: string, p: string) => Buffer)(keyId, 'crove.meetings.v1|wrap');
    await admin(async (c) => {
      await c.query(
        `INSERT INTO crove_meetings.meeting (org_id, id, title, language, started_at, ended_at, length_seconds, recorder_user_id, visibility, status, consent_method, consent_confirmed_by, consent_confirmed_at, consent_notice_version, audio_retention_date, text_retention_date)
         VALUES ($1, $2, 'Họp tuần', 'vi', now(), now() + interval '20 minutes', 1200, $3, 'attendees', 'ready', 'told_at_start', $3, now(), '1.0', current_date + 30, current_date + 365)`,
        [orgId, meetingId, users[who]],
      );
      await c.query(`INSERT INTO crove_meetings.media_key (org_id, id, meeting_id, key_id, kind, wrapped_key) VALUES ($1, $2, $3, $4, 'audio', $5)`, [orgId, randomUUID(), meetingId, keyId, wrapMediaKeyWithSubkey(dataKey, { ...binding, keyId }, subkey)]);
      for (let order = 0; order < 2; order += 1) {
        const ciphertext = encryptBlobBuffer(randomBytes(2000), dataKey, binding);
        const sha = sha256Hex(ciphertext);
        const storageKey = `org/${orgId}/${sha}`;
        await store.put(storageKey, ciphertext);
        const fileId = randomUUID();
        await c.query(
          `INSERT INTO crove_kernel.file (org_id, id, sha256, storage_key, filename, content_type, size_bytes, source) VALUES ($1, $2, $3, $4, 'meeting.opus', 'audio/ogg', $5, 'meeting_audio')`,
          [orgId, fileId, sha, storageKey, ciphertext.length],
        );
        await c.query(`INSERT INTO crove_meetings.audio_segment (org_id, id, meeting_id, file_id, segment_order, start_offset_seconds, length_seconds) VALUES ($1, $2, $3, $4, $5, $6, 600)`, [orgId, randomUUID(), meetingId, fileId, order, order * 600]);
      }
    });
    return meetingId;
  }

  const start = (who: string, meetingId: string) => app.execute<{ runId: string }>('meetings.transcript.start', { meetingId }, { actor: asUser(who), orgId });
  const agentOf = async (who: string) => (await admin((c) => c.query<{ id: string }>(`SELECT id FROM crove_kernel.agent WHERE org_id = $1 AND member_user_id = $2 AND kind = 'member_vy'`, [orgId, users[who]]))).rows[0]?.id as string;
  const status = (who: string, meetingId: string) => app.query<{ enabled: boolean; state: string; runId: string | null; errorCode: string | null }>('meetings.transcript.status', { meetingId }, { actor: asUser(who), orgId });
  async function runJob(who: string, meetingId: string, runId: string, measurer?: MediaMeasurer) {
    return runMeetingsTranscribe(deps(measurer), { orgId, meetingId, runId, agentId: await agentOf(who) });
  }
  const refuses = async (promise: Promise<unknown>) => promise.then(() => null, (error: unknown) => (error as { code?: string }).code ?? 'ERR');

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
    const appPool = createPool({ connectionString: login('crove_app', 'test-app-pw'), max: 3 });
    const workerPool = createPool({ connectionString: login('crove_worker', 'test-worker-pw'), max: 4 });
    pools.push(appPool, workerPool);
    const build = (db: ReturnType<typeof createDb>) =>
      new Runtime(db, { manifests: TEST_MANIFESTS }).register({
        commands: [...kernelCommands, ...meetingsCommands],
        queries: [...kernelQueries({ inboundDomain: null }), ...meetingsQueries],
      });
    app = build(createDb(appPool));
    worker = build(createDb(workerPool));
    setTranscribeEnabled(true);
    for (const key of ['owner', 'recorder', 'other', 'former']) {
      users[key] = await upsertIdentity(createDb(appPool), { issuer: 'transcribe', subject: key, email: `${key}@transcribe.test`, name: null });
    }
    orgId = (await createOrg(app, { type: 'user', userId: users.owner as string, aal: 'aal1' }, 'Transcribe')).orgId;
    await admin((c) =>
      c.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member'), ($1, $4, 'member')`, [orgId, users.recorder, users.other, users.former]),
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

  it('runs end to end: the recorder starts, the worker transcribes by audio length as the recorder\'s Vy, the recorder copies the result into the draft', async () => {
    const meetingId = await seedMeeting('recorder');
    expect((await status('recorder', meetingId)).state).toBe('none');
    const before = providerCalls;
    const { runId } = await start('recorder', meetingId);
    // The event for the worker carries ids only.
    const event = await admin((c) => c.query<{ payload: Record<string, unknown> }>(`SELECT payload FROM crove_kernel.outbox_event WHERE org_id = $1 AND type = 'meetings.transcript.requested'`, [orgId]));
    expect(Object.keys(event.rows[0]?.payload ?? {}).sort()).toEqual(['agentId', 'meetingId', 'runId']);
    expect((await status('recorder', meetingId)).state).toBe('running');

    expect(await runJob('recorder', meetingId, runId)).toBe('succeeded');
    expect(providerCalls - before).toBe(2);
    expect(await status('recorder', meetingId)).toMatchObject({ enabled: true, state: 'ready', runId, errorCode: null });

    // Metered by audio length (2 x 600 s at 0.5 a minute), charged to the recorder's own Vy, under the meetings module and feature.
    const usage = await admin((c) => c.query<{ amount: string; agent_id: string; module: string; feature: string }>(`SELECT amount::text, agent_id, module, feature FROM crove_kernel.org_usage WHERE org_id = $1 AND feature = 'meetings.transcribe'`, [orgId]));
    expect(usage.rows.map((r) => r.amount).sort()).toEqual(['5.000000', '5.000000']);
    expect(new Set(usage.rows.map((r) => `${r.agent_id}|${r.module}`))).toEqual(new Set([`${await agentOf('recorder')}|meetings`]));
    // The run is closed by the worker, and the job wrote no meeting table: nothing is in the draft until the recorder copies.
    const run = await admin((c) => c.query<{ status: string }>(`SELECT status FROM crove_kernel.ai_run WHERE org_id = $1 AND id = $2`, [orgId, runId]));
    expect(run.rows[0]?.status).toBe('succeeded');
    const drafts = () => admin((c) => c.query<{ n: string }>(`SELECT count(*)::text AS n FROM crove_meetings.transcript_segment WHERE org_id = $1 AND meeting_id = $2`, [orgId, meetingId]));
    expect((await drafts()).rows[0]?.n).toBe('0');

    // Only the recorder copies, and the copy is the draft shape of M4a.
    expect(await refuses(app.execute('meetings.transcript.copy_result', { meetingId, runId }, { actor: asUser('other'), orgId }))).toBe('MEETING_NOT_FOUND');
    expect(await refuses(app.execute('meetings.transcript.copy_result', { meetingId, runId }, { actor: asUser('owner'), orgId }))).toBe('MEETING_NOT_FOUND');
    expect((await drafts()).rows[0]?.n).toBe('0');
    const copied = await app.execute<{ stored: number }>('meetings.transcript.copy_result', { meetingId, runId }, { actor: asUser('recorder'), orgId });
    expect(copied.stored).toBe(4);
    // The copied rows are the model's text: born tainted, and each names the run it came from (#2941); nothing but the recorder's review clears either.
    const born = await admin((c) => c.query<{ tainted: boolean; source_run_id: string | null }>(`SELECT tainted, source_run_id FROM crove_meetings.transcript_segment WHERE org_id = $1 AND meeting_id = $2`, [orgId, meetingId]));
    expect(born.rows).toHaveLength(4);
    expect(born.rows.every((r) => r.tainted && r.source_run_id === runId)).toBe(true);
    const transcript = await app.query<{ stage: string; segments: Array<{ text: string; startSeconds: number }> }>('meetings.transcript.get', { meetingId }, { actor: asUser('recorder'), orgId });
    expect(transcript.stage).toBe('draft');
    expect(transcript.segments.map((s) => s.startSeconds)).toEqual([0, 5, 600, 605]);
    // No other member reads the draft.
    const seenByOther = await app.query<{ segments: unknown[] }>('meetings.transcript.get', { meetingId }, { actor: asUser('other'), orgId }).then((r) => r.segments.length, () => 0);
    expect(seenByOther).toBe(0);
  });

  it('charges the length crove-media measures in the audio, not the length the row stores (#2985)', async () => {
    const meetingId = await seedMeeting('recorder');
    // A row written before uploads were measured: it says 5 seconds for audio that really is 600 (what the fake sandbox measures).
    await admin((c) => c.query(`UPDATE crove_meetings.audio_segment SET length_seconds = 5 WHERE org_id = $1 AND meeting_id = $2`, [orgId, meetingId]));
    const { runId } = await start('recorder', meetingId);
    const heard: number[] = [];
    const measuring: MediaMeasurer = { ...fakeMediaMeasurer(600), measureBytes: async () => (heard.push(600), 600) };
    expect(await runJob('recorder', meetingId, runId, measuring)).toBe('succeeded');
    expect(heard).toHaveLength(2);
    const recorderAgent = await agentOf('recorder');
    const usage = await admin((c) => c.query<{ amount: string }>(`SELECT amount::text FROM crove_kernel.org_usage WHERE org_id = $1 AND feature = 'meetings.transcribe' AND agent_id = $2 AND created_at > now() - interval '1 minute'`, [orgId, recorderAgent]));
    expect(usage.rows.map((r) => r.amount).sort().slice(-2)).toEqual(['5.000000', '5.000000']);
  });

  it('fails the run before any call or charge when the sandbox is down or refuses the audio (#2985)', async () => {
    const callsBefore = providerCalls;
    for (const [measurer, code] of [
      [mediaMeasurerFor(undefined), 'TRANSCRIBE_UNAVAILABLE'],
      [{ ...fakeMediaMeasurer(), measureBytes: async () => Promise.reject(new DomainError('MEDIA_PROBE_FAILED', 422, 'x')) }, 'TRANSCRIBE_FAILED'],
      [{ ...fakeMediaMeasurer(), measureBytes: async () => Promise.reject(new DomainError('MEDIA_TOO_LONG', 413, 'x')) }, 'TRANSCRIPT_TOO_LONG'],
    ] as Array<[MediaMeasurer, string]>) {
      const meetingId = await seedMeeting('recorder');
      const { runId } = await start('recorder', meetingId);
      expect(await runJob('recorder', meetingId, runId, measurer)).toBe('failed');
      expect(await status('recorder', meetingId)).toMatchObject({ state: 'failed', errorCode: code });
    }
    expect(providerCalls).toBe(callsBefore);
  });

  it('refuses a chunk whose measured length is over the limit, before it is sent (#2985)', async () => {
    const meetingId = await seedMeeting('recorder');
    const { runId } = await start('recorder', meetingId);
    const callsBefore = providerCalls;
    expect(await runJob('recorder', meetingId, runId, fakeMediaMeasurer(90 * 60 + 1))).toBe('failed');
    expect(await status('recorder', meetingId)).toMatchObject({ errorCode: 'TRANSCRIPT_TOO_LONG' });
    expect(providerCalls).toBe(callsBefore);
  });

  it('refuses a run for the wrong meeting, and copy of another meeting\'s result', async () => {
    const mine = await seedMeeting('recorder');
    const theirs = await seedMeeting('other');
    // An attendees-only meeting of another recorder is not even visible to a member who is no reader; a reader who is not the recorder is refused.
    expect(await refuses(start('recorder', theirs))).toBe('MEETING_NOT_FOUND');
    await admin((c) => c.query(`INSERT INTO crove_meetings.meeting_reader (org_id, id, meeting_id, user_id) VALUES ($1, $2, $3, $4)`, [orgId, randomUUID(), theirs, users.recorder]));
    expect(await refuses(start('recorder', theirs))).toBe('FORBIDDEN');
    const { runId } = await start('recorder', mine);
    await runJob('recorder', mine, runId);
    expect(await refuses(app.execute('meetings.transcript.copy_result', { meetingId: theirs, runId }, { actor: asUser('recorder'), orgId }))).toBe('FORBIDDEN');
  });

  it('refuses a non-recorder, and a former member\'s run ends without a result', async () => {
    const meetingId = await seedMeeting('former');
    const { runId } = await start('former', meetingId);
    expect(await refuses(start('other', meetingId))).toBe('MEETING_NOT_FOUND');
    // The member leaves before the worker picks the job up: the entry of the context is refused, no audio is read, no provider call is made.
    await admin((c) => c.query(`DELETE FROM crove_kernel.tenant_member WHERE org_id = $1 AND user_id = $2`, [orgId, users.former]));
    const before = providerCalls;
    expect(await runJob('former', meetingId, runId)).toBe('failed');
    expect(providerCalls).toBe(before);
    const row = await admin((c) => c.query<{ status: string; body: string | null }>(`SELECT status, body FROM crove_kernel.member_vy_result WHERE org_id = $1 AND run_id = $2`, [orgId, runId]));
    expect(row.rows[0]?.status).not.toBe('ready');
    expect(row.rows[0]?.body).toBeNull();
    expect(await refuses(app.execute('meetings.transcript.copy_result', { meetingId, runId }, { actor: asUser('former'), orgId }))).toBe('NOT_A_MEMBER');
    expect(await refuses(start('former', meetingId))).toBe('NOT_A_MEMBER');
  });

  it('with transcription off the meeting works and nothing starts; a kill switch and a spent budget refuse before any call', async () => {
    const meetingId = await seedMeeting('recorder');
    setTranscribeEnabled(false);
    expect(await refuses(start('recorder', meetingId))).toBe('TRANSCRIBE_OFF');
    expect(await status('recorder', meetingId)).toMatchObject({ enabled: false, state: 'none' });
    setTranscribeEnabled(true);
    // No credential key: no job could be worked, so the start is refused with its own code and nothing is queued (#2863).
    setTranscribeBroker(false);
    try {
      expect(await refuses(start('recorder', meetingId))).toBe('TRANSCRIBE_NO_BROKER');
      expect(await status('recorder', meetingId)).toMatchObject({ enabled: false, state: 'none' });
    } finally {
      setTranscribeBroker(true);
    }
    expect(await status('recorder', meetingId)).toMatchObject({ enabled: true, state: 'none' });
    // The meeting itself is untouched by any of this.
    expect(await app.query('meetings.meeting.get', { meetingId }, { actor: asUser('recorder'), orgId })).toMatchObject({ id: meetingId });

    // An org kill switch: start is refused with the kernel's AI refusal, and a run already started stops at its next entry.
    const { runId } = await start('recorder', meetingId);
    await admin((c) => c.query(`INSERT INTO crove_kernel.kill_switch (org_id, scope, target, engaged_by) VALUES ($1, 'org', '*', $2)`, [orgId, users.owner]));
    const before = providerCalls;
    expect(await runJob('recorder', meetingId, runId)).toBe('failed');
    expect(providerCalls).toBe(before);
    expect(await refuses(start('recorder', meetingId))).toBe('AI_BUDGET_EXHAUSTED');
    await admin((c) => c.query(`UPDATE crove_kernel.kill_switch SET released_at = now(), released_by = $2 WHERE org_id = $1`, [orgId, users.owner]));

    // A spent hard-stop budget for the module: refused at start, before any provider call.
    await admin(async (c) => {
      await c.query(`INSERT INTO crove_kernel.budget_policy (org_id, scope, target, monthly_limit, hard_stop, updated_by) VALUES ($1, 'module', 'meetings', 1, true, $2)`, [orgId, users.owner]);
      await c.query(`INSERT INTO crove_kernel.org_usage (org_id, metric, amount, feature, module) VALUES ($1, 'ai_cost', 5, 'meetings.transcribe', 'meetings')`, [orgId]);
    });
    expect(await refuses(start('recorder', meetingId))).toBe('AI_BUDGET_EXHAUSTED');
    expect(providerCalls).toBe(before);
    await admin((c) => c.query(`DELETE FROM crove_kernel.budget_policy WHERE org_id = $1`, [orgId]));
  });

  it('does not start a meeting that is already being transcribed, and a switch that appears mid-run stops it before the next chunk', async () => {
    const meetingId = await seedMeeting('recorder');
    const { runId } = await start('recorder', meetingId);
    expect(await refuses(start('recorder', meetingId))).toBe('TRANSCRIBE_RUNNING');
    // A kill switch engaged while chunk 1 is at the provider: chunk 1 was admitted and paid, chunk 2 is refused at its admit, one provider call is made, the run fails.
    const before = providerCalls;
    afterFirstCall = async () => {
      await admin((c) => c.query(`INSERT INTO crove_kernel.kill_switch (org_id, scope, target, engaged_by) VALUES ($1, 'module', 'meetings', $2)`, [orgId, users.owner]));
    };
    expect(await runJob('recorder', meetingId, runId)).toBe('failed');
    afterFirstCall = null;
    expect(providerCalls - before).toBe(1);
    expect((await status('recorder', meetingId)).state).toBe('failed');
    const run = await admin((c) => c.query<{ status: string }>(`SELECT status FROM crove_kernel.ai_run WHERE org_id = $1 AND id = $2`, [orgId, runId]));
    expect(run.rows[0]?.status).toBe('failed');
    await admin((c) => c.query(`UPDATE crove_kernel.kill_switch SET released_at = now(), released_by = $2 WHERE org_id = $1`, [orgId, users.owner]));
  });

  it('does not start the transcription of another meeting while one of the recorder\'s is still going, and the first one is not cut off (#3029)', async () => {
    const first = await seedMeeting('recorder');
    const second = await seedMeeting('recorder');
    const { runId } = await start('recorder', first);
    expect(await refuses(start('recorder', second))).toBe('TRANSCRIBE_OTHER_RUNNING');
    const first1 = await admin((c) => c.query<{ status: string; error: string | null }>(`SELECT status, error FROM crove_kernel.ai_run WHERE org_id = $1 AND id = $2`, [orgId, runId]));
    expect(first1.rows[0]).toEqual({ status: 'running', error: null });
    // The refused start made no run and no result for the second meeting.
    const made = await admin((c) => c.query<{ n: string }>(`SELECT count(*)::text AS n FROM crove_kernel.member_vy_result WHERE org_id = $1 AND subject_id = $2`, [orgId, second]));
    expect(made.rows[0]?.n).toBe('0');
    // Once the first has ended (finished, failed or cancelled), the second starts.
    await admin((c) => c.query(`UPDATE crove_kernel.ai_run SET status = 'cancelled', finished_at = now() WHERE org_id = $1 AND id = $2`, [orgId, runId]));
    expect(await start('recorder', second)).toMatchObject({ runId: expect.any(String) });
    // Cleaned up for the tests after this one.
    await admin((c) => c.query(`UPDATE crove_kernel.ai_run SET status = 'cancelled', finished_at = now() WHERE org_id = $1 AND status = 'running'`, [orgId]));
  });

  const resultRows = (runId: string) => admin((c) => c.query<{ n: string }>(`SELECT count(*)::text AS n FROM crove_kernel.member_vy_result WHERE org_id = $1 AND run_id = $2`, [orgId, runId]));

  it('a meeting deleted while it is transcribed stops the run before the next chunk and leaves no result row', async () => {
    const meetingId = await seedMeeting('recorder');
    const { runId } = await start('recorder', meetingId);
    const before = providerCalls;
    // The owner's compliance delete (here by SQL: the database trigger is what every path of deleting a meeting goes through) while chunk 1 is at the provider.
    afterFirstCall = async () => void (await admin((c) => c.query(`DELETE FROM crove_meetings.meeting WHERE org_id = $1 AND id = $2`, [orgId, meetingId])));
    expect(await runJob('recorder', meetingId, runId)).toBe('failed');
    expect(providerCalls - before).toBe(1);
    expect((await resultRows(runId)).rows[0]?.n).toBe('0');
    const run = await admin((c) => c.query<{ status: string; error: string | null }>(`SELECT status, error FROM crove_kernel.ai_run WHERE org_id = $1 AND id = $2`, [orgId, runId]));
    expect(run.rows[0]).toEqual({ status: 'cancelled', error: 'MEETING_REMOVED' });
    // The run the deletion stopped has an audit row of its own, by the system, with ids and no text (#2863, item 5).
    const audit = await admin((c) =>
      c.query<{ actor_type: string; command: string; outcome: string; target_type: string; target_id: string; detail: Record<string, unknown> }>(
        `SELECT actor_type, command, outcome, target_type, target_id, detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'meetings.vy.run_cancelled' AND target_id = $2`,
        [orgId, runId],
      ),
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({ actor_type: 'system', outcome: 'ok', target_type: 'kernel.ai_run', target_id: runId });
    expect(audit.rows[0]?.detail).toMatchObject({ runId, meetingId, feature: 'meetings.transcribe', reason: 'MEETING_REMOVED' });
  });

  it('deleting a meeting with no live run writes no cancellation audit row (#2863)', async () => {
    const meetingId = await seedMeeting('recorder');
    await admin((c) => c.query(`DELETE FROM crove_meetings.meeting WHERE org_id = $1 AND id = $2`, [orgId, meetingId]));
    const audit = await admin((c) => c.query<{ n: string }>(`SELECT count(*)::text AS n FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'meetings.vy.run_cancelled' AND detail ->> 'meetingId' = $2`, [orgId, meetingId]));
    expect(audit.rows[0]?.n).toBe('0');
  });

  it('a run that already finished is not cancelled again and writes no audit row (#2863)', async () => {
    const meetingId = await seedMeeting('recorder');
    const { runId } = await start('recorder', meetingId);
    await admin((c) => c.query(`UPDATE crove_kernel.ai_run SET status = 'succeeded', finished_at = now() WHERE org_id = $1 AND id = $2`, [orgId, runId]));
    await admin((c) => c.query(`DELETE FROM crove_meetings.meeting WHERE org_id = $1 AND id = $2`, [orgId, meetingId]));
    const audit = await admin((c) => c.query<{ n: string }>(`SELECT count(*)::text AS n FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'meetings.vy.run_cancelled' AND target_id = $2`, [orgId, runId]));
    expect(audit.rows[0]?.n).toBe('0');
  });

  it('a recorder demoted to viewer mid-run stops the run before the next chunk', async () => {
    const meetingId = await seedMeeting('other');
    const { runId } = await start('other', meetingId);
    const before = providerCalls;
    afterFirstCall = async () => void (await admin((c) => c.query(`UPDATE crove_kernel.tenant_member SET role = 'viewer' WHERE org_id = $1 AND user_id = $2`, [orgId, users.other])));
    expect(await runJob('other', meetingId, runId)).toBe('failed');
    expect(providerCalls - before).toBe(1);
    const row = await admin((c) => c.query<{ status: string }>(`SELECT status FROM crove_kernel.member_vy_result WHERE org_id = $1 AND run_id = $2`, [orgId, runId]));
    expect(row.rows[0]?.status).not.toBe('ready');
    await admin((c) => c.query(`UPDATE crove_kernel.tenant_member SET role = 'member' WHERE org_id = $1 AND user_id = $2`, [orgId, users.other]));
  });

  it('a finished result that was never copied goes with its meeting', async () => {
    const meetingId = await seedMeeting('recorder');
    const { runId } = await start('recorder', meetingId);
    expect(await runJob('recorder', meetingId, runId)).toBe('succeeded');
    expect((await resultRows(runId)).rows[0]?.n).toBe('1');
    await admin((c) => c.query(`DELETE FROM crove_meetings.meeting WHERE org_id = $1 AND id = $2`, [orgId, meetingId]));
    expect((await resultRows(runId)).rows[0]?.n).toBe('0');
  });

  it('the recorder\'s own delete (the user-context path) mid-run stops the run and leaves no result row', async () => {
    const meetingId = await seedMeeting('recorder');
    const { runId } = await start('recorder', meetingId);
    const before = providerCalls;
    afterFirstCall = async () => void (await app.execute('meetings.meeting.delete', { meetingId }, { actor: asUser('recorder'), orgId }));
    expect(await runJob('recorder', meetingId, runId)).toBe('failed');
    expect(providerCalls - before).toBe(1);
    expect((await resultRows(runId)).rows[0]?.n).toBe('0');
    // In a user context the audit stamp names the member who deleted it (#2863).
    const named = await admin((c) => c.query<{ actor_type: string; actor_id: string | null }>(`SELECT actor_type, actor_id FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'meetings.vy.run_cancelled' AND target_id = $2`, [orgId, runId]));
    expect(named.rows).toEqual([{ actor_type: 'user', actor_id: users.recorder }]);
  });

  it('the text purge of the retention job (system context) mid-run stops the run and leaves no result row', async () => {
    const meetingId = await seedMeeting('recorder');
    const { runId } = await start('recorder', meetingId);
    await admin((c) => c.query(`UPDATE crove_meetings.meeting SET text_retention_date = current_date - 1 WHERE org_id = $1 AND id = $2`, [orgId, meetingId]));
    const before = providerCalls;
    // The text period has ended: the audio door refuses at once (before the first chunk is sent), and the purge removes the meeting and the result with it.
    expect(await runJob('recorder', meetingId, runId)).toBe('failed');
    expect(providerCalls).toBe(before);
    await worker.execute('meetings.retention.shred', { meetingId, kind: 'text' }, { actor: { type: 'system', component: 'meetings.retention' }, orgId });
    expect((await resultRows(runId)).rows[0]?.n).toBe('0');
  });

  it('an audio shred mid-run stops the run with MEDIA_KEY_SHREDDED and no further provider call', async () => {
    const meetingId = await seedMeeting('recorder');
    const { runId } = await start('recorder', meetingId);
    const before = providerCalls;
    afterFirstCall = async () => void (await admin((c) => c.query(`DELETE FROM crove_meetings.media_key WHERE org_id = $1 AND meeting_id = $2`, [orgId, meetingId])));
    expect(await runJob('recorder', meetingId, runId)).toBe('failed');
    expect(providerCalls - before).toBe(1);
    const row = await admin((c) => c.query<{ status: string; error_code: string | null }>(`SELECT status, error_code FROM crove_kernel.member_vy_result WHERE org_id = $1 AND run_id = $2`, [orgId, runId]));
    expect(row.rows[0]).toEqual({ status: 'failed', error_code: 'MEDIA_KEY_SHREDDED' });
  });

  // #2863 item 1: the audio's retention date ends its period from that day, before the nightly shred has run: no run starts, and a run under way ends as the shred does.
  it('refuses to start once the audio retention date is reached, and a run under way ends with MEDIA_KEY_SHREDDED', async () => {
    const late = await seedMeeting('recorder');
    await admin((c) => c.query(`UPDATE crove_meetings.meeting SET audio_retention_date = (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date WHERE org_id = $1 AND id = $2`, [orgId, late]));
    expect(await refuses(start('recorder', late))).toBe('MEDIA_KEY_SHREDDED');
    const meetingId = await seedMeeting('recorder');
    const { runId } = await start('recorder', meetingId);
    await admin((c) => c.query(`UPDATE crove_meetings.meeting SET audio_retention_date = (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date WHERE org_id = $1 AND id = $2`, [orgId, meetingId]));
    const before = providerCalls;
    expect(await runJob('recorder', meetingId, runId)).toBe('failed');
    expect(providerCalls).toBe(before);
    const row = await admin((c) => c.query<{ status: string; error_code: string | null }>(`SELECT status, error_code FROM crove_kernel.member_vy_result WHERE org_id = $1 AND run_id = $2`, [orgId, runId]));
    expect(row.rows[0]).toEqual({ status: 'failed', error_code: 'MEDIA_KEY_SHREDDED' });
  });
});

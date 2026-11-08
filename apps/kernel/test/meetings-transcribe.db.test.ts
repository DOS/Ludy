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
  Runtime,
  encryptBlobBuffer,
  sha256Hex,
  wrapMediaKeyWithSubkey,
  type BlobStore,
  type CredentialBroker,
} from '@crove/kernel-runtime';
import { meetingsCommands, meetingsQueries, setTranscribeEnabled } from '@crove/mod-meetings';
import { runMeetingsTranscribe, type MeetingsTranscribeDeps } from '../src/meetings-transcribe.ts';
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
  const deps = (): MeetingsTranscribeDeps => ({ runtime: worker, store, broker, provider, price: { inputPerMTok: '0', outputPerMTok: '0', audioPerMinute: '0.5' } });
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
  async function runJob(who: string, meetingId: string, runId: string) {
    return runMeetingsTranscribe(deps(), { orgId, meetingId, runId, agentId: await agentOf(who) });
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
    expect(await refuses(app.execute('meetings.transcript.copy_result', { meetingId, runId }, { actor: asUser('other'), orgId }))).not.toBeNull();
    expect(await refuses(app.execute('meetings.transcript.copy_result', { meetingId, runId }, { actor: asUser('owner'), orgId }))).not.toBeNull();
    expect((await drafts()).rows[0]?.n).toBe('0');
    const copied = await app.execute<{ stored: number }>('meetings.transcript.copy_result', { meetingId, runId }, { actor: asUser('recorder'), orgId });
    expect(copied.stored).toBe(4);
    const transcript = await app.query<{ stage: string; segments: Array<{ text: string; startSeconds: number }> }>('meetings.transcript.get', { meetingId }, { actor: asUser('recorder'), orgId });
    expect(transcript.stage).toBe('draft');
    expect(transcript.segments.map((s) => s.startSeconds)).toEqual([0, 5, 600, 605]);
    // No other member reads the draft.
    const seenByOther = await app.query<{ segments: unknown[] }>('meetings.transcript.get', { meetingId }, { actor: asUser('other'), orgId }).then((r) => r.segments.length, () => 0);
    expect(seenByOther).toBe(0);
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
    expect(await refuses(app.execute('meetings.transcript.copy_result', { meetingId: theirs, runId }, { actor: asUser('recorder'), orgId }))).not.toBeNull();
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
    expect(await refuses(app.execute('meetings.transcript.copy_result', { meetingId, runId }, { actor: asUser('former'), orgId }))).not.toBeNull();
    expect(await refuses(start('former', meetingId))).not.toBeNull();
  });

  it('with transcription off the meeting works and nothing starts; a kill switch and a spent budget refuse before any call', async () => {
    const meetingId = await seedMeeting('recorder');
    setTranscribeEnabled(false);
    expect(await refuses(start('recorder', meetingId))).toBe('TRANSCRIBE_OFF');
    expect(await status('recorder', meetingId)).toMatchObject({ enabled: false, state: 'none' });
    setTranscribeEnabled(true);
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
});

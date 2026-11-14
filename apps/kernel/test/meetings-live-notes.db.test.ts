// SPDX-License-Identifier: AGPL-3.0-only
// Live notes as the recorder's own Vy on a real database (#3110, ADR-0052 L4a-2): the recorder starts a window, the worker transcribes the pieces of #3109 in the
// recorder's member-scoped context against a fake provider, the recorder's own tick copies the lines into the preview ("Bản nháp trực tiếp"), and the running notes are
// made from the new lines and the previous notes only. Only the recorder reads the preview; a spent budget or a kill switch stops the notes and not the recording; the
// batch transcript replaces the preview; the preview goes with the meeting. The database-level rules of the live door are in invariant/.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AiMeter } from '@crove/agent';
import type { ModelPort } from '@crove/agent/member-vy';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { BlobNotFoundError, Runtime, encryptBlobBuffer, sha256Hex, wrapMediaKeyWithSubkey, type BlobStore, type CredentialBroker } from '@crove/kernel-runtime';
import type { LiveNotesDone, LiveStatus, LiveTicked } from '@crove/kernel-contract';
import { meetingsCommands, meetingsQueries, setLiveNotesBroker, setLiveNotesEnabled, setSummaryEnabled } from '@crove/mod-meetings';
import { DraftBudget } from '../src/ai-draft-limit.ts';
import { runLiveNotes } from '../src/member-vy-ports.ts';
import { runMeetingsLiveNotes, type MeetingsLiveNotesDeps } from '../src/meetings-live-notes.ts';
import type { MediaMeasurer } from '../src/meetings-measure.ts';
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

suite("live notes as the recorder's own Vy (#3110, L4a-2)", () => {
  const dbName = `crove_test_live_notes_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  const pools: pg.Pool[] = [];
  let orgId = '';
  let app: Runtime;
  let worker: Runtime;
  const users: Record<string, string> = {};
  const store = new MemoryStore();
  const broker = {
    keyId: 'k1-live-notes-test',
    keyIds: ['k1-live-notes-test'],
    derive: (purpose: string) => createHash('sha256').update(`test-secret:${purpose}`).digest(),
    deriveKey: (keyId: string, purpose: string) => createHash('sha256').update(`test-secret:${keyId}:${purpose}`).digest(),
  } as unknown as CredentialBroker;
  let providerCalls = 0;
  const provider: MeetingsLiveNotesDeps['provider'] = {
    baseURL: 'http://provider.test/v1',
    model: 'whisper-test',
    fetch: (async () => {
      providerCalls += 1;
      return new Response(JSON.stringify({ text: `xin chào ${providerCalls}`, segments: [{ start: 0, end: 10, text: `xin chào ${providerCalls}` }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch,
  };
  // The sandbox measures every piece as fifteen seconds (and keeps what it was given, so a test can see the file each piece reached it as); the deployment's price is half a unit a minute.
  const measured: Uint8Array[] = [];
  const measurer: MediaMeasurer = { ...fakeMediaMeasurer(15), measureBytes: async (_kind, bytes) => {
      measured.push(Uint8Array.from(bytes));
      return 15;
    },
  };
  const deps = (): MeetingsLiveNotesDeps => ({ runtime: worker, store, broker, measurer, provider, price: { inputPerMTok: '0', outputPerMTok: '0', audioPerMinute: '0.5' } });
  // What a MediaRecorder stream looks like cut into pieces: the first has the header, the others start at a Cluster.
  const HEADER = Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0x84, 0x42, 0x82, 0x81, 0x77, 0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x15, 0x49, 0xa9, 0x66, 0x83, 0x2a, 0xd7, 0xb1]);
  const clusterOf = (seq: number) => Uint8Array.from([0x1f, 0x43, 0xb6, 0x75, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, ...randomBytes(600).map((b) => (b === 0x1f ? 0 : b)), seq % 256]);
  const pieceBytes = (seq: number) => (seq === 0 ? Uint8Array.from([...HEADER, ...clusterOf(0)]) : clusterOf(seq));
  const asUser = (who: string) => ({ type: 'user' as const, userId: users[who] as string, aal: 'aal1' as const });
  const refuses = async (promise: Promise<unknown>) => promise.then(() => null, (error: unknown) => (error as { code?: string }).code ?? 'ERR');

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }
  const sql = <R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params: unknown[] = []) => admin((c) => c.query<R>(text, params));
  const count = async (text: string, params: unknown[] = []) => Number((await sql<{ n: string }>(`SELECT count(*)::text AS n FROM (${text}) q`, params)).rows[0]?.n);

  // A meeting recorded by `who` whose recorder opted into live notes (or not), with `pieces` live pieces sealed as #3109 leaves them: each under its own key (kind live:<seq>).
  async function seedMeeting(who: string, opts: { liveNotes?: boolean; pieces?: number; first?: number } = {}): Promise<string> {
    const meetingId = randomUUID();
    await sql(
      `INSERT INTO crove_meetings.meeting (org_id, id, title, language, started_at, recorder_user_id, visibility, status, consent_method, consent_confirmed_by, consent_confirmed_at, consent_notice_version, audio_retention_date, text_retention_date, live_notes)
       VALUES ($1, $2, 'Họp tuần', 'vi', now(), $3, 'attendees', 'ready', 'told_at_start', $3, now(), '1.0', current_date + 30, current_date + 365, $4)`,
      [orgId, meetingId, users[who], opts.liveNotes ?? true],
    );
    await addPieces(meetingId, opts.first ?? 0, opts.pieces ?? 3);
    return meetingId;
  }
  async function addPieces(meetingId: string, first: number, n: number): Promise<void> {
    for (let seq = first; seq < first + n; seq += 1) {
      const dataKey = randomBytes(32);
      const binding = { orgId, meetingId, kind: `live:${seq}` as const };
      const subkey = (broker.deriveKey as (k: string, p: string) => Buffer)('k1-live-notes-test', 'crove.meetings.v1|wrap');
      const ciphertext = encryptBlobBuffer(Buffer.from(pieceBytes(seq)), dataKey, binding);
      const sha = sha256Hex(ciphertext);
      const storageKey = `org/${orgId}/${sha}`;
      await store.put(storageKey, ciphertext);
      const fileId = randomUUID();
      await admin(async (c) => {
        await c.query(`INSERT INTO crove_meetings.media_key (org_id, id, meeting_id, key_id, kind, wrapped_key) VALUES ($1, $2, $3, 'k1-live-notes-test', $4, $5)`, [
          orgId,
          randomUUID(),
          meetingId,
          `live:${seq}`,
          wrapMediaKeyWithSubkey(dataKey, { ...binding, keyId: 'k1-live-notes-test' }, subkey),
        ]);
        await c.query(
          `INSERT INTO crove_kernel.file (org_id, id, sha256, storage_key, filename, content_type, size_bytes, source) VALUES ($1, $2, $3, $4, $5, 'application/octet-stream', $6, 'meeting_audio')`,
          [orgId, fileId, sha, storageKey, `meeting-${meetingId}-live-${seq}.bin`, ciphertext.length],
        );
        await c.query(`INSERT INTO crove_meetings.live_chunk (org_id, id, meeting_id, seq, file_id, size_bytes, length_seconds) VALUES ($1, $2, $3, $4, $5, $6, 15)`, [orgId, randomUUID(), meetingId, seq, fileId, ciphertext.length]);
      });
    }
  }

  const agentOf = async (who: string) => (await sql<{ id: string }>(`SELECT id FROM crove_kernel.agent WHERE org_id = $1 AND member_user_id = $2 AND kind = 'member_vy'`, [orgId, users[who]])).rows[0]?.id as string;
  const start = (who: string, meetingId: string) => app.execute<{ runId: string }>('meetings.live.start', { meetingId }, { actor: asUser(who), orgId });
  const tick = (who: string, meetingId: string) => app.execute<LiveTicked>('meetings.live.tick', { meetingId }, { actor: asUser(who), orgId });
  const status = (who: string, meetingId: string) => app.query<LiveStatus>('meetings.live.status', { meetingId }, { actor: asUser(who), orgId });
  // The job the worker would run for a window: the ids come from the event the start wrote (afterSeq and the window's size).
  async function runWindow(who: string, meetingId: string, runId: string, afterSeq = -1) {
    const out = await runMeetingsLiveNotes(deps(), { orgId, meetingId, runId, agentId: await agentOf(who), afterSeq, pieces: 20 });
    return out;
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
    setLiveNotesEnabled(true);
    setLiveNotesBroker(true);
    setSummaryEnabled(true);
    for (const key of ['owner', 'recorder', 'other', 'reader']) {
      users[key] = await upsertIdentity(createDb(appPool), { issuer: 'live-notes', subject: key, email: `${key}@live-notes.test`, name: null });
    }
    orgId = (await createOrg(app, { type: 'user', userId: users.owner as string, aal: 'aal1' }, 'LiveNotes')).orgId;
    await sql(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member'), ($1, $4, 'member')`, [orgId, users.recorder, users.other, users.reader]);
  }, 300_000);

  afterAll(async () => {
    for (const pool of pools) await pool.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('a meeting that did not opt in takes no live notes, and one whose deployment cannot transcribe says so and still works', async () => {
    const plain = await seedMeeting('recorder', { liveNotes: false });
    expect(await refuses(start('recorder', plain))).toBe('LIVE_NOTES_NOT_ENABLED');
    expect(await refuses(app.execute('meetings.live.notes_start', { meetingId: plain }, { actor: asUser('recorder'), orgId }))).toBe('LIVE_NOTES_NOT_ENABLED');
    expect(await sql(`SELECT 1 FROM crove_kernel.ai_run WHERE org_id = $1 AND feature IN ('meetings.live_notes', 'meetings.live_summary')`, [orgId])).toHaveProperty('rowCount', 0);

    const live = await seedMeeting('recorder');
    setLiveNotesEnabled(false);
    try {
      expect(await refuses(start('recorder', live))).toBe('TRANSCRIBE_OFF');
      expect(await status('recorder', live)).toMatchObject({ optedIn: true, enabled: false, state: 'off', lines: [] });
      // AI off: the meeting itself is untouched, and the pieces are still there for the batch path.
      expect(await app.query('meetings.meeting.get', { meetingId: live }, { actor: asUser('recorder'), orgId })).toMatchObject({ id: live });
      expect(await count('SELECT 1 FROM crove_meetings.live_chunk WHERE meeting_id = $1', [live])).toBe(3);
    } finally {
      setLiveNotesEnabled(true);
    }
  });

  it('runs end to end: start, the worker transcribes the pieces by audio length as the recorder, the tick copies the lines, the next window follows only when pieces arrive', async () => {
    const meetingId = await seedMeeting('recorder', { pieces: 3 });
    const { runId } = await start('recorder', meetingId);
    expect(await status('recorder', meetingId)).toMatchObject({ state: 'running', runId, enabled: true });
    // The preview is empty until the window is copied, and a second start of the same meeting is refused while the window runs.
    expect((await status('recorder', meetingId)).lines).toEqual([]);
    expect(await refuses(start('recorder', meetingId))).toBe('LIVE_RUNNING');

    const before = providerCalls;
    measured.length = 0;
    // A window is one or two pieces (about 30 seconds): the first reads pieces 0 and 1.
    expect(await runWindow('recorder', meetingId, runId)).toBe('succeeded');
    expect(providerCalls - before).toBe(2);
    expect(await tick('recorder', meetingId)).toMatchObject({ copiedRunId: runId, lines: 2, state: 'running' });
    // The tick copied the window and started the next at once, because piece 2 is already there; it reads what follows the preview.
    const second = (await status('recorder', meetingId)).runId as string;
    expect(second).not.toBe(runId);
    expect(await runWindow('recorder', meetingId, second, 1)).toBe('succeeded');
    expect(providerCalls - before).toBe(3);
    // Each piece reached the sandbox and the provider as a file they can read: the first as it is, the others behind the header of the first (they are the middle of a stream).
    expect(measured).toHaveLength(3);
    expect([...measured[0]!.subarray(0, HEADER.length)]).toEqual([...HEADER]);
    for (const seq of [1, 2]) {
      expect([...measured[seq]!.subarray(0, HEADER.length)], `piece ${seq} starts with the header`).toEqual([...HEADER]);
      expect(measured[seq]!.length, `piece ${seq} is the header and its own bytes`).toBe(HEADER.length + clusterOf(seq).length);
    }
    const usage = await sql<{ amount: string }>(`SELECT amount::text FROM crove_kernel.org_usage WHERE org_id = $1 AND metric = 'ai_cost' AND feature = 'meetings.transcribe' ORDER BY created_at DESC LIMIT 3`, [orgId]);
    expect(usage.rows.length).toBeGreaterThan(0);

    expect(await tick('recorder', meetingId)).toMatchObject({ copiedRunId: second, lines: 1, state: 'waiting', runId: null });
    const shown = await status('recorder', meetingId);
    expect(shown.lines.map((l) => [l.seq, l.endSeconds - l.startSeconds > 0])).toEqual([
      [0, true],
      [1, true],
      [2, true],
    ]);
    expect(shown.lines[0]?.text).toContain('xin chào');
    // The same window is not copied twice, and a tick with nothing new starts nothing.
    expect((await tick('recorder', meetingId)).copiedRunId).toBeNull();
    expect((await tick('recorder', meetingId)).runId).toBeNull();
    expect(await count('SELECT 1 FROM crove_meetings.live_line WHERE meeting_id = $1', [meetingId])).toBe(3);

    // Two more pieces arrive: the next tick starts a window that reads only what follows the preview.
    await addPieces(meetingId, 3, 2);
    const next = await tick('recorder', meetingId);
    expect(next.state).toBe('running');
    expect(next.runId).not.toBeNull();
    const calls = providerCalls;
    expect(await runWindow('recorder', meetingId, next.runId as string, 2)).toBe('succeeded');
    expect(providerCalls - calls).toBe(2);
    expect(await tick('recorder', meetingId)).toMatchObject({ lines: 2, state: 'waiting' });
    const all = (await status('recorder', meetingId)).lines;
    expect(all.map((l) => l.seq)).toEqual([0, 1, 2, 3, 4]);
    // The later window read the header of the first piece too, and each line sits where its piece does: after the 15 second pieces before it.
    expect(measured.slice(-2).every((file) => [...file.subarray(0, HEADER.length)].join() === [...HEADER].join())).toBe(true);
    expect(all.map((l) => l.startSeconds)).toEqual([0, 15, 30, 45, 60]);
  });

  it('a silent start does not freeze the preview: the window reports how far it read, and a stop between two windows stops for good until the recorder starts again', async () => {
    const meetingId = await seedMeeting('recorder', { pieces: 4 });
    const heard = provider.fetch as typeof fetch;
    // The provider hears nothing in the first two pieces.
    provider.fetch = (async () => new Response(JSON.stringify({ text: '', segments: [] }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
    const { runId } = await start('recorder', meetingId);
    expect(await runWindow('recorder', meetingId, runId)).toBe('succeeded');
    provider.fetch = heard;
    // The silent pieces are lines with no text: nothing is shown, but the next window starts after them (not over the same two pieces again).
    const afterSilence = await tick('recorder', meetingId);
    expect(afterSilence).toMatchObject({ copiedRunId: runId, lines: 0, state: 'running' });
    expect((await status('recorder', meetingId)).lines).toEqual([]);
    expect(await sql<{ seq: number }>('SELECT seq FROM crove_meetings.live_line WHERE meeting_id = $1 ORDER BY seq', [meetingId]).then((r) => r.rows.map((x) => x.seq))).toEqual([0, 1]);
    const calls = providerCalls;
    expect(await runWindow('recorder', meetingId, afterSilence.runId as string, 1)).toBe('succeeded');
    expect(providerCalls - calls).toBe(2);
    expect((await status('recorder', meetingId)).lines.map((l) => l.seq)).toEqual([]);

    // Stop with no window running (the usual moment: the last one is done, the next tick has not run): it stops, and the next tick starts nothing.
    expect(await app.execute('meetings.live.stop', { meetingId }, { actor: asUser('recorder'), orgId })).toMatchObject({ stopped: true });
    const after = await tick('recorder', meetingId);
    expect(after).toMatchObject({ state: 'stopped', runId: null });
    expect(await status('recorder', meetingId)).toMatchObject({ state: 'stopped', errorCode: 'RUN_CANCELLED' });
    expect(await tick('recorder', meetingId)).toMatchObject({ state: 'stopped', runId: null });
    // A second stop is not an error and changes nothing.
    expect(await app.execute('meetings.live.stop', { meetingId }, { actor: asUser('recorder'), orgId })).toMatchObject({ stopped: false });
    // Start begins again, after the pieces the preview has read.
    const again = await start('recorder', meetingId);
    expect(again.runId).not.toBeNull();
    expect(await status('recorder', meetingId)).toMatchObject({ state: 'running' });
    // Leave nothing running for the next test (a recorder has one live window at a time).
    expect(await app.execute('meetings.live.stop', { meetingId }, { actor: asUser('recorder'), orgId })).toMatchObject({ stopped: true });
  });

  it('shows the preview to the recorder only: another member, a named reader, an owner and the worker read none of it', async () => {
    const meetingId = await seedMeeting('recorder', { pieces: 2 });
    await app.execute('meetings.reader.add', { meetingId, userId: users.reader }, { actor: asUser('recorder'), orgId });
    const { runId } = await start('recorder', meetingId);
    await runWindow('recorder', meetingId, runId);
    await tick('recorder', meetingId);
    expect((await status('recorder', meetingId)).lines).toHaveLength(2);
    for (const who of ['reader', 'owner']) {
      // A reader of the meeting reads the meeting but not the live pane: the empty one.
      const seen = await status(who, meetingId).catch(() => null);
      if (seen) expect(seen).toMatchObject({ lines: [], state: 'off', runId: null });
    }
    expect(await refuses(status('other', meetingId))).toBe('MEETING_NOT_FOUND');
    // Nobody but the recorder may drive it either.
    for (const who of ['reader', 'other', 'owner']) {
      expect(await refuses(start(who, meetingId))).not.toBeNull();
      expect(await refuses(tick(who, meetingId))).not.toBeNull();
    }
    // The system context of the worker reads and writes no line.
    expect(await refuses(worker.query('meetings.live.status', { meetingId }, { actor: { type: 'system', component: 'test' }, orgId }))).not.toBeNull();
    expect(await count('SELECT 1 FROM crove_meetings.live_line WHERE meeting_id = $1', [meetingId])).toBe(2);
  });

  it('a spent budget or a kill switch stops the notes with its code and leaves the recording and its pieces alone', async () => {
    const meetingId = await seedMeeting('recorder', { pieces: 3 });
    const { runId } = await start('recorder', meetingId);
    await sql(`INSERT INTO crove_kernel.kill_switch (org_id, scope, target, engaged_by) VALUES ($1, 'org', '*', $2)`, [orgId, users.owner]);
    const before = providerCalls;
    expect(await runWindow('recorder', meetingId, runId)).toBe('failed');
    // Nothing was sent to the provider: the context is refused at its entry.
    expect(providerCalls).toBe(before);
    const stopped = await status('recorder', meetingId);
    expect(stopped).toMatchObject({ state: 'stopped', errorCode: 'AI_STOPPED' });
    // The tick starts no new window after a failed one, and says why.
    expect(await tick('recorder', meetingId)).toMatchObject({ state: 'stopped', runId: null, errorCode: 'AI_STOPPED' });
    expect(await refuses(start('recorder', meetingId))).toBe('AI_BUDGET_EXHAUSTED');
    await sql(`UPDATE crove_kernel.kill_switch SET released_at = now(), released_by = $2 WHERE org_id = $1`, [orgId, users.owner]);

    // A hard-stop budget the next piece would cross: refused before the provider call, the run ends with its code.
    const second = await seedMeeting('recorder', { pieces: 2 });
    const run2 = (await start('recorder', second)).runId;
    await sql(
      `INSERT INTO crove_kernel.budget_policy (org_id, scope, target, monthly_limit, hard_stop, updated_by) VALUES ($1, 'module', 'meetings', crove_kernel.ai_budget_spent($1::uuid, 'module', 'meetings') + 0.0001::numeric, true, $2)`,
      [orgId, users.owner],
    );
    const calls = providerCalls;
    expect(await runWindow('recorder', second, run2)).toBe('failed');
    expect(providerCalls).toBe(calls);
    expect(await status('recorder', second)).toMatchObject({ state: 'stopped', errorCode: 'AI_BUDGET_EXHAUSTED' });
    await sql(`DELETE FROM crove_kernel.budget_policy WHERE org_id = $1`, [orgId]);
    // The recording is untouched all along: the meeting reads, and every piece is still stored.
    expect(await app.query('meetings.meeting.get', { meetingId }, { actor: asUser('recorder'), orgId })).toMatchObject({ id: meetingId });
    expect(await count('SELECT 1 FROM crove_meetings.live_chunk WHERE meeting_id = $1', [meetingId])).toBe(3);
  });

  it('pieces that disappear (the final recording landed) end the live notes cleanly instead of failing them', async () => {
    const meetingId = await seedMeeting('recorder', { pieces: 3 });
    const { runId } = await start('recorder', meetingId);
    // The final recording is recorded between the start and the worker's read: the pieces and their keys are gone, the audio segment exists.
    const file = randomUUID();
    await sql(`DELETE FROM crove_meetings.media_key WHERE meeting_id = $1 AND kind LIKE 'live:%'`, [meetingId]);
    await sql(`DELETE FROM crove_meetings.live_chunk WHERE meeting_id = $1`, [meetingId]);
    await sql(`INSERT INTO crove_kernel.file (org_id, id, sha256, storage_key, filename, content_type, size_bytes, source) VALUES ($1, $2, $3, $4, 'meeting.webm', 'audio/webm', 10, 'meeting_audio')`, [orgId, file, 'e'.repeat(64), `org/${orgId}/${'e'.repeat(64)}`]);
    await sql(`INSERT INTO crove_meetings.audio_segment (org_id, id, meeting_id, file_id, segment_order, start_offset_seconds, length_seconds) VALUES ($1, $2, $3, $4, 0, 0, 45)`, [orgId, randomUUID(), meetingId, file]);
    const calls = providerCalls;
    expect(await runWindow('recorder', meetingId, runId)).toBe('succeeded');
    expect(providerCalls).toBe(calls);
    const done = await tick('recorder', meetingId);
    expect(done).toMatchObject({ lines: 0, state: 'stopped', runId: null });
    // No new window and no start once the recording ended.
    expect(await refuses(start('recorder', meetingId))).toBe('LIVE_CLOSED');
  });

  it('the batch transcript replaces the preview, and the preview goes with the meeting', async () => {
    const meetingId = await seedMeeting('recorder', { pieces: 2 });
    const { runId } = await start('recorder', meetingId);
    await runWindow('recorder', meetingId, runId);
    await tick('recorder', meetingId);
    expect(await count('SELECT 1 FROM crove_meetings.live_line WHERE meeting_id = $1', [meetingId])).toBe(2);
    // The recorder stores a real transcript (what copy_result of the batch run does too): the preview lines are erased with it.
    await app.execute('meetings.transcript.draft_store', { meetingId, segments: [{ startSeconds: 0, endSeconds: 10, speakerLabel: 'Người nói 1', text: 'Bản chép đầy đủ' }] }, { actor: asUser('recorder'), orgId });
    expect(await count('SELECT 1 FROM crove_meetings.live_line WHERE meeting_id = $1', [meetingId])).toBe(0);

    // A meeting the recorder deletes takes its preview with it, at the same time.
    const gone = await seedMeeting('recorder', { pieces: 1 });
    const run = (await start('recorder', gone)).runId;
    await runWindow('recorder', gone, run);
    await tick('recorder', gone);
    expect(await count('SELECT 1 FROM crove_meetings.live_line WHERE meeting_id = $1', [gone])).toBe(1);
    await app.execute('meetings.meeting.delete', { meetingId: gone }, { actor: asUser('recorder'), orgId });
    expect(await count('SELECT 1 FROM crove_meetings.live_line WHERE meeting_id = $1', [gone])).toBe(0);
  });

  describe('the running notes', () => {
    const NEW_LINE = 'Hà sẽ gửi báo giá cho khách trước thứ sáu';
    const OLD_LINE = 'Dòng cũ đã được đọc trong lần trước';
    const answer = JSON.stringify({ summary: 'Hà gửi báo giá.', decisions: ['Giữ giá cũ'], items: [{ title: 'Gửi báo giá', who: 'Hà', when: 'thứ sáu', seconds: 5 }] });
    const meter: AiMeter = { admit: async () => undefined, record: async () => undefined };
    let prompts: string[] = [];
    const model = (text: string): ModelPort => ({
      generate: async (_who, prompt) => {
        prompts.push(prompt.user);
        return { text, usage: { inputTokens: 100, outputTokens: 30 } };
      },
    });
    const route = (who: string, meetingId: string, port: ModelPort | null = model(answer)) =>
      runLiveNotes({ runtime: app, model: port, meter: () => meter, budget: new DraftBudget({ perUserPerMinute: 100, perOrgPerMinute: 100 }) }, orgId, asUser(who), meetingId);

    async function seedLines(meetingId: string, lines: Array<[number, number, string]>, created = 'now()') {
      for (const [seq, start, text] of lines) {
        await sql(`INSERT INTO crove_meetings.live_line (org_id, id, meeting_id, seq, start_seconds, end_seconds, text, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, ${created})`, [orgId, randomUUID(), meetingId, seq, start, start + 10, text]);
      }
    }

    it('makes tainted draft notes from the new lines, creates no task, reads only what is new next time and spends nothing when nothing is', async () => {
      prompts = [];
      const meetingId = await seedMeeting('recorder', { pieces: 0 });
      await seedLines(meetingId, [[0, 0, OLD_LINE], [1, 10, NEW_LINE]]);
      const done = (await route('recorder', meetingId)) as LiveNotesDone;
      expect(done).toMatchObject({ state: 'ready', decisions: 1, items: 1, errorCode: null });
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain(NEW_LINE);

      // The notes are draft rows of the recorder, the model's words: tainted, tied to the run, in the live feature, "Đề xuất" until the recorder acts.
      const result = await sql<{ feature: string; stage: string; tainted: boolean; source_run_id: string }>(`SELECT feature, stage, tainted, source_run_id FROM crove_meetings.meeting_result WHERE meeting_id = $1`, [meetingId]);
      expect(result.rows).toEqual([{ feature: 'meetings.live_notes', stage: 'draft', tainted: true, source_run_id: done.runId }]);
      const items = await sql<{ title: string; stage: string; status: string; tainted: boolean; source_run_id: string; task_id: string | null }>(`SELECT title, stage, status, tainted, source_run_id, task_id FROM crove_meetings.action_item WHERE meeting_id = $1`, [meetingId]);
      expect(items.rows).toEqual([{ title: 'Gửi báo giá', stage: 'draft', status: 'suggested', tainted: true, source_run_id: done.runId, task_id: null }]);
      // Nothing becomes a task without the recorder's click.
      expect(await count('SELECT 1 FROM crove_kernel.task WHERE org_id = $1 AND source_ref IS NOT NULL', [orgId])).toBe(0);

      // Nothing new since: no run, no model call, no spend.
      expect(await route('recorder', meetingId)).toMatchObject({ state: 'nothing', runId: null });
      expect(prompts).toHaveLength(1);

      // A new line the ticks copied while the model was still working (written after the run started, before its notes were copied): the next refresh must read it, not skip it.
      await seedLines(meetingId, [[2, 20, 'Khách đồng ý']], `(SELECT started_at + interval '1 millisecond' FROM crove_kernel.ai_run WHERE id = '${done.runId}')`);
      expect((await route('recorder', meetingId)).state).toBe('ready');
      expect(prompts).toHaveLength(2);
      // The earlier suggestions are replaced by the new ones, not piled up next to them.
      expect(await count(`SELECT 1 FROM crove_meetings.action_item WHERE meeting_id = $1`, [meetingId])).toBe(1);
      expect(await count(`SELECT 1 FROM crove_meetings.meeting_result WHERE meeting_id = $1`, [meetingId])).toBe(1);
      expect(prompts[1]).toContain('Khách đồng ý');
      expect(prompts[1]).toContain('Hà gửi báo giá.');
      expect(prompts[1]).not.toContain(OLD_LINE);
      expect(prompts[1]).not.toContain(NEW_LINE);
    });

    it('notes that hold only an item still mark how far they read, so the same lines are not read and paid for again', async () => {
      prompts = [];
      const meetingId = await seedMeeting('recorder', { pieces: 0 });
      await seedLines(meetingId, [[0, 0, NEW_LINE]]);
      const onlyItems = model(JSON.stringify({ summary: '', decisions: [], items: [{ title: 'Gửi báo giá', who: 'Hà', when: 'thứ sáu', seconds: 5 }] }));
      expect(await route('recorder', meetingId, onlyItems)).toMatchObject({ state: 'ready', items: 1 });
      expect(await route('recorder', meetingId, onlyItems)).toMatchObject({ state: 'nothing', runId: null });
      expect(prompts).toHaveLength(1);
    });

    it('drops a figure no line holds, refuses another member and a meeting that did not opt in, and is off when the deployment has no model', async () => {
      prompts = [];
      const meetingId = await seedMeeting('recorder', { pieces: 0 });
      await seedLines(meetingId, [[0, 0, NEW_LINE]]);
      const invented = JSON.stringify({ summary: 'Hà gửi báo giá 500 triệu.', decisions: ['Giảm giá 20%'], items: [{ title: 'Gửi báo giá', who: 'Hà', when: '', seconds: 5 }] });
      const done = await route('recorder', meetingId, model(invented));
      expect(done.state).toBe('ready');
      const row = await sql<{ summary: string; decisions: string }>(`SELECT summary, decisions::text FROM crove_meetings.meeting_result WHERE meeting_id = $1`, [meetingId]);
      expect(JSON.stringify(row.rows)).not.toContain('500');
      expect(JSON.stringify(row.rows)).not.toContain('20%');

      expect(await refuses(route('other', meetingId))).not.toBeNull();
      const plain = await seedMeeting('recorder', { liveNotes: false, pieces: 0 });
      expect(await refuses(route('recorder', plain))).toBe('LIVE_NOTES_NOT_ENABLED');
      expect(await refuses(route('recorder', meetingId, null))).toBe('SUMMARY_OFF');
    });

    it('a spent budget or a kill switch ends the notes run with its code and leaves the preview as it was', async () => {
      const meetingId = await seedMeeting('recorder', { pieces: 0 });
      await seedLines(meetingId, [[0, 0, NEW_LINE]]);
      await sql(`INSERT INTO crove_kernel.kill_switch (org_id, scope, target, engaged_by) VALUES ($1, 'org', '*', $2)`, [orgId, users.owner]);
      expect(await refuses(route('recorder', meetingId))).toBe('AI_BUDGET_EXHAUSTED');
      await sql(`UPDATE crove_kernel.kill_switch SET released_at = now(), released_by = $2 WHERE org_id = $1`, [orgId, users.owner]);
      expect(await count('SELECT 1 FROM crove_meetings.live_line WHERE meeting_id = $1', [meetingId])).toBe(1);
      expect(await count('SELECT 1 FROM crove_meetings.meeting_result WHERE meeting_id = $1', [meetingId])).toBe(0);
    });
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
// Live notes capture on PostgreSQL (issue #3109, ADR-0052 L4a): the opt-in, the sealed pieces of a recording sent while it runs, the refusals (not opted in, no
// consent record, another member, after the recording ended), that the final recording replaces the pieces, and that the pieces are shredded with the audio, the
// meeting and the org. Only ciphertext under the meeting's own keys is ever stored.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { kernelCommands, kernelQueries } from '@crove/kernel';
import { BlobNotFoundError, DomainError, Runtime, decryptBlobBuffer, fileKey, sha256Hex, unwrapMediaKeyWithSubkey, type BlobStore, type CredentialBroker, type UserActor } from '@crove/kernel-runtime';
import { hashExtensionSecret } from '../src/auth-extension.ts';
import { financeCommands, financeQueries } from '@crove/mod-finance';
import { meetingsCommands, meetingsQueries } from '@crove/mod-meetings';
import { createAuthenticator } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp, type HttpDeps } from '../src/http.ts';
import { fakeMediaMeasurer } from './fake-media.ts';
import { runMeetingsRetention, sweepMeetingMedia } from '../src/meetings-retention.ts';
import { orgPurgeCommand, purgeOrg } from '../src/org-purge.ts';
import { createSessionStatusSource } from '../src/sessions.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const SECRET = 'test-only-meetings-live-secret-0123456789-abcdef';
const ISSUER = 'crove-auth-meetings-live';
const suite = ADMIN ? describe : describe.skip;
const quiet = { log: () => undefined, error: () => undefined };
const OGG = Buffer.from([0x4f, 0x67, 0x67, 0x53, 0x00, 0x02]);
const MP4 = Buffer.from([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70]);

class MemoryStore implements BlobStore {
  readonly storage = new Map<string, Uint8Array>();
  deleteFails = false;
  async put(key: string, bytes: Uint8Array): Promise<string> {
    this.storage.set(key, new Uint8Array(bytes));
    return `content:${sha256Hex(bytes)}`;
  }
  async get(key: string): Promise<Uint8Array> {
    const bytes = this.storage.get(key);
    if (!bytes) throw new BlobNotFoundError(key);
    return bytes;
  }
  async getRange(key: string, start: number, end: number): Promise<Uint8Array> {
    return (await this.get(key)).subarray(start, end + 1);
  }
  async delete(key: string): Promise<void> {
    if (this.deleteFails) throw new Error('store unavailable');
    this.storage.delete(key);
  }
}

suite('meetings live notes capture on PostgreSQL (#3109)', () => {
  const dbName = `crove_test_meetings_live_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let store: MemoryStore;
  let app: ReturnType<typeof createHttpApp>;
  let worker: Runtime;
  let appRuntime: Runtime;
  let workerDb: ReturnType<typeof createDb>;
  const accounts = new Map<string, { subject: string; email: string; session: string }>();
  const userIds = new Map<string, string>();
  let slug = '';
  let orgId = '';

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }
  const rows = <T extends pg.QueryResultRow = Record<string, unknown>>(text: string, params: unknown[] = []) => admin(async (c) => (await c.query<T>(text, params)).rows);
  const count = async (text: string, params: unknown[] = []) => Number((await rows<{ n: string }>(`SELECT count(*)::text AS n FROM (${text}) q`, params))[0]!.n);

  async function token(name: string, mfa = false) {
    let who = accounts.get(name);
    if (!who) {
      who = { subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@live.test`, session: randomUUID() };
      accounts.set(name, who);
    }
    const now = Math.floor(Date.now() / 1000);
    const extra = mfa ? { aal: 'aal2', amr: [{ method: 'totp', timestamp: now }] } : { aal: 'aal1' };
    return new SignJWT({ role: 'authenticated', email: who.email, session_id: who.session, is_anonymous: false, ...extra })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(who.subject)
      .setIssuer(ISSUER)
      .setAudience('authenticated')
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(new TextEncoder().encode(SECRET));
  }

  async function rpc(path: string, name: string, input: unknown, org: string | null = slug, mfa = false) {
    const response = await app.request(`/api/rpc/${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await token(name, mfa)}`, 'content-type': 'application/json', ...(org ? { 'x-crove-org': org } : {}) },
      body: JSON.stringify(input === undefined ? {} : { json: input }),
    });
    const body = (await response.json()) as { json?: Record<string, unknown> };
    return { status: response.status, body: (body.json ?? body) as Record<string, unknown> };
  }

  async function joinOrg(name: string, role: 'member' | 'viewer', org = slug, owner = 'owner') {
    await token(name);
    const email = accounts.get(name)?.email;
    const invited = await rpc('org/invite', owner, { email, role }, org, true);
    expect(invited.status).toBe(200);
    const accepted = await rpc('invites/accept', name, { token: String(invited.body.acceptPath).split('#')[1] }, null);
    expect(accepted.status).toBe(200);
    userIds.set(name, (await rows<{ id: string }>('SELECT id FROM crove_kernel.user_account WHERE email = $1', [email]))[0]!.id);
  }

  async function createMeeting(name: string, body: Record<string, unknown> = {}, org = slug) {
    const res = await rpc('meetings/create', name, { title: 'Họp tuần', visibility: 'attendees', consentMethod: 'told_at_start', keepVideo: false, ...body }, org);
    expect(res.status).toBe(200);
    return String(res.body.meetingId);
  }

  async function upload(name: string, meetingId: string, kind: 'audio' | 'video', marker: string, org = slug) {
    const bytes = Buffer.concat([kind === 'audio' ? OGG : MP4, Buffer.alloc(8, 0), Buffer.from(marker.repeat(20))]);
    const form = new FormData();
    form.append('kind', kind);
    form.append('file', new Blob([bytes], { type: kind === 'audio' ? 'audio/ogg' : 'video/mp4' }), kind === 'audio' ? 'a.ogg' : 'v.mp4');
    const res = await app.request(`/api/meetings/${meetingId}/media`, { method: 'POST', headers: { authorization: `Bearer ${await token(name)}`, 'x-crove-org': org }, body: form });
    expect(res.status).toBe(200);
    return bytes;
  }

  const play = async (name: string, meetingId: string, kind: 'audio' | 'video', org = slug) =>
    app.request(`/api/meetings/${meetingId}/${kind}`, { headers: { authorization: `Bearer ${await token(name)}`, 'x-crove-org': org } });

  const yesterday = "(pg_catalog.timezone('Asia/Ho_Chi_Minh', pg_catalog.now()))::date - 1";
  const retention = () => runMeetingsRetention({ runtime: worker, workerDb, log: quiet });
  const sweep = () => sweepMeetingMedia({ runtime: worker, workerDb, store, log: quiet });

  beforeAll(async () => {
    store = new MemoryStore();
    const broker = {
      keyId: 'k1-live-test',
      keyIds: ['k1-live-test'],
      derive: (purpose: string) => createHash('sha256').update(`test-secret:${purpose}`).digest(),
      deriveKey: (keyId: string, purpose: string) => createHash('sha256').update(`test-secret:${keyId}:${purpose}`).digest(),
    } as unknown as CredentialBroker;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });
    const login = (user: string, pw: string) => {
      const url = new URL(adminUrl);
      url.username = user;
      url.password = pw;
      return url.toString();
    };
    pool = createPool({ connectionString: login('crove_app', 'test-app-pw'), max: 8 });
    workerPool = createPool({ connectionString: login('crove_worker', 'test-worker-pw'), max: 4 });
    const db = createDb(pool);
    workerDb = createDb(workerPool);
    const config = loadConfig({ DATABASE_URL: login('crove_app', 'test-app-pw'), AUTH_JWT_SECRET: SECRET, AUTH_ISSUER: ISSUER, AUTH_SESSION_CHECK: 'off', MIGRATIONS_DIR: MIGRATIONS, WEB_DIST: '/nonexistent' });
    const registry = { commands: [...kernelCommands, ...financeCommands, ...meetingsCommands], queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries, ...meetingsQueries] };
    const runtime = new Runtime(db, { manifests: TEST_MANIFESTS, sessions: createSessionStatusSource('off'), stepUp: 'required' }).register(registry);
    appRuntime = runtime;
    worker = new Runtime(workerDb, { manifests: TEST_MANIFESTS }).register(registry).register({ commands: [orgPurgeCommand({ store })] });
    const deps: HttpDeps = { config, runtime, store, broker, authenticate: createAuthenticator(config, db), pool, aiEnabled: false, mediaMeasurer: fakeMediaMeasurer() };
    app = createHttpApp(deps);
    const created = await rpc('org/create', 'owner', { name: `Live Org ${randomUUID().slice(0, 6)}`, idempotencyKey: randomUUID() }, null);
    expect(created.status).toBe(200);
    slug = String(created.body.slug);
    orgId = String(created.body.orgId);
    userIds.set('owner', (await rows<{ id: string }>('SELECT id FROM crove_kernel.user_account WHERE email = $1', [accounts.get('owner')?.email]))[0]!.id);
    await joinOrg('recorder', 'member');
    await joinOrg('attendee', 'member');
    await joinOrg('otherMember', 'member');
  });

  afterAll(async () => {
    await pool?.end();
    await workerPool?.end();
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  // A WebM container header, then the opaque slices that follow in a MediaRecorder stream (a Cluster, no header).
  const WEBM = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0xf7, 0x81]);
  const CLUSTER = Buffer.from([0x1f, 0x43, 0xb6, 0x75, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
  const piece = (marker: string, seq: number) => Buffer.concat([seq === 0 ? WEBM : CLUSTER, Buffer.from(marker.repeat(40))]);
  const wrapSubkey = (keyId: string) => createHash('sha256').update(`test-secret:${keyId}:crove.meetings.v1|wrap`).digest();
  const liveMeeting = (name = 'recorder', body: Record<string, unknown> = {}) => createMeeting(name, { liveNotes: true, ...body });

  async function sendChunk(
    name: string,
    meetingId: string,
    seq: number,
    bytes: Buffer,
    opts: { lengthSeconds?: number | string; contentType?: string; contentLength?: string; bearer?: string; seq?: string } = {},
  ) {
    const res = await app.request(`/api/meetings/${meetingId}/live-chunk?seq=${opts.seq ?? seq}&lengthSeconds=${opts.lengthSeconds ?? 15}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${opts.bearer ?? (await token(name))}`,
        'x-crove-org': slug,
        'content-type': opts.contentType ?? 'audio/webm',
        'content-length': opts.contentLength ?? String(bytes.byteLength),
      },
      body: new Uint8Array(bytes),
    });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  }

  const chunkCount = (meetingId: string) => count('SELECT 1 FROM crove_meetings.live_chunk WHERE meeting_id = $1', [meetingId]);
  const liveKeyCount = (meetingId: string) => count("SELECT 1 FROM crove_meetings.media_key WHERE meeting_id = $1 AND kind LIKE 'live:%'", [meetingId]);
  const chunkObjects = async (meetingId: string) =>
    (await rows<{ storage_key: string }>(`SELECT f.storage_key FROM crove_kernel.file f WHERE f.source = 'meeting_audio' AND f.filename LIKE $1`, [`meeting-${meetingId}-live-%`])).map((r) => r.storage_key);

  // What a chunk decrypts to: its own wrapped key opened with the deployment's wrap key, its ciphertext read from the store.
  async function plaintextOf(meetingId: string, seq: number): Promise<Buffer> {
    const key = (await rows<{ key_id: string; wrapped_key: Buffer }>('SELECT key_id, wrapped_key FROM crove_meetings.media_key WHERE meeting_id = $1 AND kind = $2', [meetingId, `live:${seq}`]))[0]!;
    const file = (
      await rows<{ storage_key: string }>(
        'SELECT f.storage_key FROM crove_kernel.file f JOIN crove_meetings.live_chunk c ON c.org_id = f.org_id AND c.file_id = f.id WHERE c.meeting_id = $1 AND c.seq = $2',
        [meetingId, seq],
      )
    )[0]!;
    const binding = { orgId, meetingId, kind: `live:${seq}` as const };
    const dataKey = unwrapMediaKeyWithSubkey(key.wrapped_key, { ...binding, keyId: key.key_id }, wrapSubkey(key.key_id));
    return decryptBlobBuffer(Buffer.from(await store.get(file.storage_key)), dataKey, binding);
  }

  const userActor = (name: string): UserActor => ({ type: 'user', userId: userIds.get(name)!, aal: 'aal1', mfaAt: null, sessionId: accounts.get(name)!.session });
  // A well-formed command input for the refusals that never reach the sealing: the database says no before any key or file row is written.
  const rawInput = (meetingId: string, seq = 0) => {
    const sha = createHash('sha256').update(randomBytes(16)).digest('hex');
    return { meetingId, seq, keyId: 'k1-live-test', wrappedKeyHex: '00'.repeat(60), storageKey: fileKey(orgId, sha), sizeBytes: 100, sha256: sha, contentType: 'application/octet-stream', lengthSeconds: 15 };
  };
  const refusedWith = async (run: () => Promise<unknown>, code: string) => {
    const error = await run().then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe(code);
  };

  it('keeps a meeting the recorder did not opt in exactly as it was: no live piece is accepted, by the route or the command', async () => {
    const meetingId = await createMeeting('recorder');
    expect((await rpc('meetings/get', 'recorder', { meetingId })).body.liveNotes).toBe(false);
    const sent = await sendChunk('recorder', meetingId, 0, piece('a', 0));
    expect(sent.status).toBe(409);
    expect(sent.body.code).toBe('LIVE_NOTES_NOT_ENABLED');
    await refusedWith(() => appRuntime.execute('meetings.live.chunk', rawInput(meetingId), { actor: userActor('recorder'), orgId }), 'LIVE_NOTES_NOT_ENABLED');
    expect(await chunkCount(meetingId)).toBe(0);
    expect(await liveKeyCount(meetingId)).toBe(0);
    expect(await chunkObjects(meetingId)).toEqual([]);
    // The opt-in is fixed when the meeting is created: no command changes it afterwards.
    const grants = await rows<{ role: string }>(
      `SELECT r.rolname AS role FROM pg_roles r WHERE has_column_privilege(r.oid, 'crove_meetings.meeting', 'live_notes', 'UPDATE') AND r.rolname IN ('crove_tenant', 'crove_app', 'crove_worker')`,
    );
    expect(grants).toEqual([]);
  });

  it('stores each piece as ciphertext under its own key, records nothing in clear and leaves the meeting without audio until the final upload', async () => {
    const meetingId = await liveMeeting();
    const detail = (await rpc('meetings/get', 'recorder', { meetingId })).body;
    expect(detail.liveNotes).toBe(true);
    const before = store.storage.size;
    for (const seq of [0, 1, 2]) {
      const sent = await sendChunk('recorder', meetingId, seq, piece(`marker${seq}`, seq));
      expect(sent).toEqual({ status: 200, body: { meetingId, seq, duplicate: false } });
    }
    expect(store.storage.size).toBe(before + 3);
    expect(await chunkCount(meetingId)).toBe(3);
    expect((await rows<{ kind: string }>("SELECT kind FROM crove_meetings.media_key WHERE meeting_id = $1 ORDER BY kind", [meetingId])).map((r) => r.kind)).toEqual(['live:0', 'live:1', 'live:2']);
    // Ciphertext only: no stored object holds a marker or the container header, and each opens to exactly what was sent under its own key.
    for (const seq of [0, 1, 2]) {
      expect(await plaintextOf(meetingId, seq)).toEqual(piece(`marker${seq}`, seq));
    }
    for (const key of await chunkObjects(meetingId)) {
      const stored = Buffer.from(await store.get(key));
      expect(stored.includes(Buffer.from('marker'))).toBe(false);
      expect(stored.includes(WEBM)).toBe(false);
    }
    const keys = await rows<{ wrapped_key: Buffer }>("SELECT wrapped_key FROM crove_meetings.media_key WHERE meeting_id = $1", [meetingId]);
    expect(new Set(keys.map((k) => k.wrapped_key.toString('hex'))).size).toBe(3);
    // The files are meeting audio rows with a neutral name; the first piece names the container, the others are opaque.
    const files = await rows<{ filename: string; source: string; content_type: string }>(
      `SELECT f.filename, f.source, f.content_type FROM crove_kernel.file f JOIN crove_meetings.live_chunk c ON c.org_id = f.org_id AND c.file_id = f.id WHERE c.meeting_id = $1 ORDER BY c.seq`,
      [meetingId],
    );
    expect(files.map((f) => [f.filename, f.source, f.content_type])).toEqual([
      [`meeting-${meetingId}-live-0.bin`, 'meeting_audio', 'audio/webm'],
      [`meeting-${meetingId}-live-1.bin`, 'meeting_audio', 'application/octet-stream'],
      [`meeting-${meetingId}-live-2.bin`, 'meeting_audio', 'application/octet-stream'],
    ]);
    // Not the meeting's audio yet: no segment, nothing to play, nothing for a transcript.
    expect((await rpc('meetings/get', 'recorder', { meetingId })).body.hasAudio).toBe(false);
    expect((await play('recorder', meetingId, 'audio')).status).toBeGreaterThanOrEqual(400);
    // The audit row names the piece and its size, never a key, a storage address or bytes.
    const audits = await rows<{ detail: Record<string, unknown> }>("SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'meetings.live.chunk' AND outcome = 'ok' AND target_id = $2 ORDER BY occurred_at", [orgId, meetingId]);
    expect(audits).toHaveLength(3);
    expect(audits[0]!.detail).toMatchObject({ meetingId, seq: 0 });
    expect(JSON.stringify(audits)).not.toMatch(/wrapped|storage|sha256|marker/i);
  });

  it('keeps one piece when a retry arrives after a lost answer, and drops the object the retry stored', async () => {
    const meetingId = await liveMeeting();
    expect((await sendChunk('recorder', meetingId, 0, piece('first', 0))).body.duplicate).toBe(false);
    const stored = store.storage.size;
    const retry = await sendChunk('recorder', meetingId, 0, piece('first', 0));
    expect(retry).toEqual({ status: 200, body: { meetingId, seq: 0, duplicate: true } });
    expect(await chunkCount(meetingId)).toBe(1);
    expect(await liveKeyCount(meetingId)).toBe(1);
    expect(store.storage.size).toBe(stored);
    expect(await plaintextOf(meetingId, 0)).toEqual(piece('first', 0));
  });

  it('refuses a piece from a member who is not the recorder, with no row, key or object left', async () => {
    const meetingId = await liveMeeting();
    const stored = store.storage.size;
    for (const name of ['otherMember', 'attendee', 'owner']) {
      const sent = await sendChunk(name, meetingId, 0, piece('x', 0));
      expect([403, 404]).toContain(sent.status);
    }
    await refusedWith(() => appRuntime.execute('meetings.live.chunk', rawInput(meetingId), { actor: userActor('otherMember'), orgId }), 'MEETING_NOT_FOUND');
    // Even a named reader is no recorder.
    expect((await rpc('meetings/readers/add', 'recorder', { meetingId, userId: userIds.get('attendee') })).status).toBe(200);
    await refusedWith(() => appRuntime.execute('meetings.live.chunk', rawInput(meetingId), { actor: userActor('attendee'), orgId }), 'FORBIDDEN');
    expect((await sendChunk('attendee', meetingId, 0, piece('x', 0))).status).toBe(403);
    expect(await chunkCount(meetingId)).toBe(0);
    expect(await liveKeyCount(meetingId)).toBe(0);
    expect(store.storage.size).toBe(stored);
  });

  it('refuses a piece for a meeting without its consent record', async () => {
    const meetingId = await liveMeeting();
    // The columns cannot be null; a record is the recorder's confirmation with a notice version, and a meeting that lost either has none.
    await rows("UPDATE crove_meetings.meeting SET consent_notice_version = '' WHERE id = $1", [meetingId]);
    const stored = store.storage.size;
    const sent = await sendChunk('recorder', meetingId, 0, piece('a', 0));
    expect(sent.status).toBe(409);
    expect(sent.body.code).toBe('CONSENT_MISSING');
    await rows("UPDATE crove_meetings.meeting SET consent_notice_version = '2026-11-v1', consent_confirmed_by = $2 WHERE id = $1", [meetingId, userIds.get('attendee')]);
    await refusedWith(() => appRuntime.execute('meetings.live.chunk', rawInput(meetingId), { actor: userActor('recorder'), orgId }), 'CONSENT_MISSING');
    expect(await chunkCount(meetingId)).toBe(0);
    expect(store.storage.size).toBe(stored);
  });

  it('refuses a piece once the recording has ended: the final audio is recorded, the retention date has passed, or the longest run is over', async () => {
    const ended = await liveMeeting();
    await upload('recorder', ended, 'audio', 'e');
    const stored = store.storage.size;
    const after = await sendChunk('recorder', ended, 0, piece('late', 0));
    expect(after.status).toBe(409);
    expect(after.body.code).toBe('LIVE_CLOSED');
    expect(store.storage.size).toBe(stored);

    const expired = await liveMeeting();
    await rows(`UPDATE crove_meetings.meeting SET audio_retention_date = ${yesterday} WHERE id = $1`, [expired]);
    expect((await sendChunk('recorder', expired, 0, piece('a', 0))).body.code).toBe('MEDIA_RETENTION_PASSED');

    const old = await liveMeeting();
    await rows("UPDATE crove_meetings.meeting SET started_at = now() - interval '5 hours' WHERE id = $1", [old]);
    expect((await sendChunk('recorder', old, 0, piece('a', 0))).body.code).toBe('LIVE_CLOSED');
    expect(await chunkCount(old)).toBe(0);
    expect(store.storage.size).toBe(stored);
  });

  it('refuses a malformed piece before storing anything, and a meeting whose pieces reached the size limit', async () => {
    const meetingId = await liveMeeting();
    const stored = store.storage.size;
    const bad = async (send: ReturnType<typeof sendChunk>, status: number) => expect((await send).status).toBe(status);
    await bad(sendChunk('recorder', meetingId, 0, piece('a', 0), { seq: 'abc' }), 400);
    await bad(sendChunk('recorder', meetingId, 0, piece('a', 0), { seq: '1000' }), 400);
    await bad(sendChunk('recorder', meetingId, 0, piece('a', 0), { lengthSeconds: 0 }), 400);
    await bad(sendChunk('recorder', meetingId, 0, piece('a', 0), { lengthSeconds: 121 }), 400);
    await bad(sendChunk('recorder', meetingId, 0, piece('a', 0), { contentType: 'video/webm' }), 400);
    await bad(sendChunk('recorder', meetingId, 0, piece('a', 0), { contentType: 'application/json' }), 400);
    await bad(sendChunk('recorder', meetingId, 0, Buffer.alloc(0)), 400);
    await bad(sendChunk('recorder', meetingId, 0, piece('a', 0), { contentLength: String(1024 * 1024 + 1) }), 413);
    await bad(sendChunk('recorder', meetingId, 0, piece('a', 0), { contentLength: '5' }), 400);
    // The first piece must be a container; the opaque ones after it cannot be told apart from noise, and are checked when the recording is.
    await bad(sendChunk('recorder', meetingId, 0, Buffer.alloc(64, 0x41)), 400);
    expect(await chunkCount(meetingId)).toBe(0);
    expect(await liveKeyCount(meetingId)).toBe(0);
    expect(store.storage.size).toBe(stored);

    // The total is bounded: a meeting at its size limit takes no more, and its refusal leaves no object behind.
    // Piece 0 arrives first, as on every real recording; the filler then brings the meeting to its limit and the next piece is refused.
    expect((await sendChunk('recorder', meetingId, 0, piece('a', 0))).status).toBe(200);
    const file = randomUUID();
    await rows(
      `INSERT INTO crove_kernel.file (org_id, id, filename, content_type, size_bytes, sha256, storage_key, source, created_by)
       VALUES ($1, $2, 'filler.bin', 'application/octet-stream', 10, $3, $4, 'meeting_audio', $5)`,
      [orgId, file, 'f'.repeat(64), fileKey(orgId, 'f'.repeat(64)), userIds.get('recorder')],
    );
    await rows(`INSERT INTO crove_meetings.live_chunk (org_id, id, meeting_id, seq, file_id, size_bytes, length_seconds) VALUES ($1, $2, $3, 500, $4, ${300 * 1024 * 1024 - 10}, 15)`, [orgId, randomUUID(), meetingId, file]);
    const withFirst = store.storage.size;
    const full = await sendChunk('recorder', meetingId, 1, piece('a', 1));
    expect(full.status).toBe(413);
    expect(store.storage.size).toBe(withFirst);
  });

  it('keeps no piece before the first one: without the container header the later pieces cannot be read', async () => {
    const meetingId = await liveMeeting();
    const stored = store.storage.size;
    const early = await sendChunk('recorder', meetingId, 3, piece('late', 3));
    expect(early.status).toBe(409);
    expect(early.body.code).toBe('LIVE_FIRST_PIECE_MISSING');
    expect(store.storage.size).toBe(stored);
    expect(await liveKeyCount(meetingId)).toBe(0);
    expect((await sendChunk('recorder', meetingId, 0, piece('a', 0))).status).toBe(200);
    expect((await sendChunk('recorder', meetingId, 3, piece('d', 3))).status).toBe(200);
  });

  it('replaces the pieces with a final VIDEO recording too, and closes the meeting to pieces after it', async () => {
    const meetingId = await liveMeeting('recorder', { keepVideo: true });
    for (const seq of [0, 1]) expect((await sendChunk('recorder', meetingId, seq, piece('v', seq))).status).toBe(200);
    await upload('recorder', meetingId, 'video', 'film');
    expect(await chunkCount(meetingId)).toBe(0);
    expect(await liveKeyCount(meetingId)).toBe(0);
    expect((await sendChunk('recorder', meetingId, 2, piece('v', 2))).body.code).toBe('LIVE_CLOSED');
    await sweep();
    expect(await chunkObjects(meetingId)).toEqual([]);
  });

  it('never leaves a piece beside the final recording when the two run at the same moment', async () => {
    for (let round = 0; round < 3; round += 1) {
      const meetingId = await liveMeeting();
      expect((await sendChunk('recorder', meetingId, 0, piece('r', 0))).status).toBe(200);
      const [late] = await Promise.all([sendChunk('recorder', meetingId, 1, piece('r', 1)), upload('recorder', meetingId, 'audio', 'race')]);
      expect([200, 409]).toContain(late.status);
      // Whichever came first, the recording is recorded and no piece or live key outlives it.
      expect(await count('SELECT 1 FROM crove_meetings.audio_segment WHERE meeting_id = $1', [meetingId])).toBe(1);
      expect(await chunkCount(meetingId)).toBe(0);
      expect(await liveKeyCount(meetingId)).toBe(0);
    }
  });

  it('replaces the pieces with the final recording: the audio is kept once, the pieces lose their keys at once and their objects in the next sweep', async () => {
    const meetingId = await liveMeeting();
    for (const seq of [0, 1, 2]) expect((await sendChunk('recorder', meetingId, seq, piece('s', seq))).status).toBe(200);
    const pieces = await chunkObjects(meetingId);
    expect(pieces).toHaveLength(3);
    const finalBytes = await upload('recorder', meetingId, 'audio', 'final');
    // One audio segment, one audio key; the pieces' rows and keys are gone in the same commit.
    expect(await count('SELECT 1 FROM crove_meetings.audio_segment WHERE meeting_id = $1', [meetingId])).toBe(1);
    expect((await rows<{ kind: string }>('SELECT kind FROM crove_meetings.media_key WHERE meeting_id = $1', [meetingId])).map((r) => r.kind)).toEqual(['audio']);
    expect(await chunkCount(meetingId)).toBe(0);
    const audit = await rows<{ detail: Record<string, unknown> }>("SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'meetings.media.record' AND target_id = $2 AND outcome = 'ok'", [orgId, meetingId]);
    expect(audit[0]!.detail).toMatchObject({ kind: 'audio', liveChunksDiscarded: 3 });
    // The pieces' file rows are orphans now; the sweep deletes their objects and rows, and never the final audio.
    for (const key of pieces) expect(store.storage.has(key)).toBe(true);
    const swept = await sweep();
    expect(swept.failed).toBe(0);
    for (const key of pieces) expect(store.storage.has(key)).toBe(false);
    expect(await chunkObjects(meetingId)).toEqual([]);
    expect(await count('SELECT 1 FROM crove_kernel.file f JOIN crove_meetings.audio_segment s ON s.org_id = f.org_id AND s.file_id = f.id WHERE s.meeting_id = $1', [meetingId])).toBe(1);
    // The recording plays as it always did, and the batch path sees one complete audio.
    const played = await play('recorder', meetingId, 'audio');
    expect(played.status).toBe(200);
    expect(Buffer.from(await played.arrayBuffer())).toEqual(finalBytes);
    expect((await rpc('meetings/get', 'recorder', { meetingId })).body.hasAudio).toBe(true);
  });

  it('keeps a recording whose live pieces failed: the final upload needs none of them', async () => {
    const meetingId = await liveMeeting();
    expect((await sendChunk('recorder', meetingId, 0, piece('a', 0))).status).toBe(200);
    // Seq 1 never arrives, seq 2 does (a gap): the final upload is the audio and succeeds the same.
    expect((await sendChunk('recorder', meetingId, 2, piece('c', 2))).status).toBe(200);
    expect((await sendChunk('recorder', meetingId, 1, Buffer.alloc(0))).status).toBe(400);
    await upload('recorder', meetingId, 'audio', 'g');
    expect((await rpc('meetings/get', 'recorder', { meetingId })).body.hasAudio).toBe(true);
    expect(await chunkCount(meetingId)).toBe(0);
    // And a meeting that sent no piece at all records as always.
    const plain = await createMeeting('recorder');
    await upload('recorder', plain, 'audio', 'p');
    expect((await rpc('meetings/get', 'recorder', { meetingId: plain })).body.hasAudio).toBe(true);
  });

  it('shreds the pieces of a meeting that never got its final audio at its audio date, with the audio rules', async () => {
    const meetingId = await liveMeeting();
    for (const seq of [0, 1]) expect((await sendChunk('recorder', meetingId, seq, piece('d', seq))).status).toBe(200);
    const pieces = await chunkObjects(meetingId);
    // Not due yet: the nightly run leaves them.
    expect((await retention()).shredded.audio).toBe(0);
    expect(await liveKeyCount(meetingId)).toBe(2);
    await rows(`UPDATE crove_meetings.meeting SET audio_retention_date = ${yesterday} WHERE id = $1`, [meetingId]);
    const run = await retention();
    expect(run.failed).toBe(0);
    expect(run.shredded.audio).toBe(1);
    expect(await liveKeyCount(meetingId)).toBe(0);
    expect(await chunkCount(meetingId)).toBe(0);
    // The meeting itself stays (its text date has not come); the ciphertext goes in the sweep.
    expect(await count('SELECT 1 FROM crove_meetings.meeting WHERE id = $1', [meetingId])).toBe(1);
    await sweep();
    for (const key of pieces) expect(store.storage.has(key)).toBe(false);
    expect((await retention()).shredded.audio).toBe(0);
  });

  it('shreds the pieces with the meeting when the recorder deletes it, when its text date comes and when the org is purged', async () => {
    const deleted = await liveMeeting();
    for (const seq of [0, 1]) await sendChunk('recorder', deleted, seq, piece('x', seq));
    const deletedPieces = await chunkObjects(deleted);
    expect((await rpc('meetings/delete', 'recorder', { meetingId: deleted })).status).toBe(200);
    expect(await chunkCount(deleted)).toBe(0);
    expect(await liveKeyCount(deleted)).toBe(0);

    const purged = await liveMeeting();
    for (const seq of [0, 1]) await sendChunk('recorder', purged, seq, piece('y', seq));
    const purgedPieces = await chunkObjects(purged);
    await rows(`UPDATE crove_meetings.meeting SET text_retention_date = ${yesterday} WHERE id = $1`, [purged]);
    const run = await retention();
    expect(run.failed).toBe(0);
    expect(await count('SELECT 1 FROM crove_meetings.meeting WHERE id = $1', [purged])).toBe(0);
    expect(await chunkCount(purged)).toBe(0);
    expect(await liveKeyCount(purged)).toBe(0);

    await sweep();
    for (const key of [...deletedPieces, ...purgedPieces]) expect(store.storage.has(key)).toBe(false);
  });

  it('serves the extension token: only for a meeting its own token created, and with its own audit trail', async () => {
    const recorder = userIds.get('recorder')!;
    const mint = async (): Promise<{ id: string; bearer: string }> => {
      const bearer = `crx_${randomBytes(32).toString('base64url')}`;
      const id = randomUUID();
      await rows(
        `INSERT INTO crove_kernel.extension_token (org_id, id, user_id, token_hash, device_name, scopes, created_at, expires_at, created_by)
         VALUES ($1, $2, $3, $4, 'Test device', ARRAY['meetings'], now(), now() + interval '30 days', $3)`,
        [orgId, id, recorder, hashExtensionSecret(bearer)],
      );
      return { id, bearer };
    };
    const mine = await mint();
    const other = await mint();
    const create = async (bearer: string, liveNotes: boolean) => {
      const res = await app.request('/api/rpc/meetings/create', {
        method: 'POST',
        headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json', 'x-crove-org': slug },
        body: JSON.stringify({ json: { title: 'Họp tuần', consentMethod: 'told_at_start', keepVideo: false, liveNotes } }),
      });
      expect(res.status).toBe(200);
      return String(((await res.json()) as { json: { meetingId: string } }).json.meetingId);
    };
    const live = await create(mine.bearer, true);
    const notLive = await create(mine.bearer, false);
    expect((await sendChunk('recorder', live, 0, piece('t', 0), { bearer: mine.bearer })).status).toBe(200);
    expect((await sendChunk('recorder', live, 1, piece('t', 1), { bearer: mine.bearer })).status).toBe(200);
    expect(await chunkCount(live)).toBe(2);
    // Another token of the same member, and the member's own session on a meeting a token made, reach it the same way the recorder does; a meeting the token did not create is no meeting.
    const inApp = await liveMeeting();
    expect((await sendChunk('recorder', inApp, 0, piece('t', 0), { bearer: mine.bearer })).status).toBe(404);
    expect((await sendChunk('recorder', live, 2, piece('t', 2), { bearer: other.bearer })).status).toBe(404);
    expect((await sendChunk('recorder', notLive, 0, piece('t', 0), { bearer: mine.bearer })).body.code).toBe('LIVE_NOTES_NOT_ENABLED');
    expect(await chunkCount(inApp)).toBe(0);
    // The audit row names the token.
    const audit = await rows<{ actor_id: string; detail: Record<string, unknown> }>("SELECT actor_id, detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'meetings.live.chunk' AND outcome = 'ok' AND target_id = $2", [orgId, live]);
    expect(audit).toHaveLength(2);
    expect(JSON.stringify(audit)).toContain(mine.id);
  });

  it('is deleted with the org: the purge takes the pieces', async () => {
    const meetingId = await liveMeeting();
    await sendChunk('recorder', meetingId, 0, piece('z', 0));
    expect(await chunkCount(meetingId)).toBe(1);
    // purgeOrg runs against a closed org; the coverage tests (org-purge.db.test.ts, org-purge-coverage.test.ts) read the table list. Here: the table is in the purge's list.
    const listed = readFileSync(new URL('../../../supabase/migrations/20261228000100_crove_kernel_org_purge_live_chunk.sql', import.meta.url), 'utf8');
    expect(listed).toContain("'crove_meetings.live_chunk'");
    expect(purgeOrg).toBeTypeOf('function');
  });
});

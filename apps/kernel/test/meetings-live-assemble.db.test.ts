// SPDX-License-Identifier: AGPL-3.0-only
// Assembling the live pieces into the recording when the final upload never arrives (issue #3126, ADR-0052 L4a), on PostgreSQL: the recorder's click joins the pieces in
// order under a fresh audio key (ciphertext only, the length measured by the sandbox), reports a gap without failing, refuses before the window has passed or without
// piece 0, loses cleanly against a final upload in either order, discards the pieces in the same transaction, and leaves shredding, deleting and the AI state alone.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { kernelCommands, kernelQueries } from '@crove/kernel';
import { BlobNotFoundError, DomainError, Runtime, fileKey, sha256Hex, type BlobStore, type CredentialBroker, type UserActor } from '@crove/kernel-runtime';
import { hashExtensionSecret } from '../src/auth-extension.ts';
import { financeCommands, financeQueries } from '@crove/mod-finance';
import { meetingsCommands, meetingsQueries } from '@crove/mod-meetings';
import { createAuthenticator } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp, type HttpDeps } from '../src/http.ts';
import { assembleLivePieces } from '../src/meetings-live-assemble.ts';
import type { MediaMeasurer } from '../src/meetings-measure.ts';
import { runMeetingsRetention, sweepMeetingMedia } from '../src/meetings-retention.ts';
import { orgPurgeCommand } from '../src/org-purge.ts';
import { createSessionStatusSource } from '../src/sessions.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const SECRET = 'test-only-meetings-assemble-secret-0123456789-abcdef';
const ISSUER = 'crove-auth-meetings-assemble';
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

suite('meetings live pieces assembled on PostgreSQL (#3126)', () => {
  const dbName = `crove_test_meetings_assemble_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let store: MemoryStore;
  let broker: CredentialBroker;
  // The stand-in for crove-media: it keeps the bytes it was asked to measure (the join, decrypted from the sealed blob) and answers a fixed length, or fails when told to.
  const measured: Buffer[] = [];
  const sandbox = { fail: false, seconds: 1800 };
  const measurer: MediaMeasurer = {
    configured: true,
    async measure(_kind, source) {
      const parts: Buffer[] = [];
      for await (const part of source) parts.push(Buffer.from(part));
      if (sandbox.fail) throw new DomainError('MEDIA_PROBE_FAILED', 422, 'The recording could not be read');
      measured.push(Buffer.concat(parts));
      return sandbox.seconds;
    },
    async measureBytes() {
      return sandbox.seconds;
    },
  };
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
      who = { subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@assemble.test`, session: randomUUID() };
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
    broker = {
      keyId: 'k1-assemble-test',
      keyIds: ['k1-assemble-test'],
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
    const deps: HttpDeps = { config, runtime, store, broker, authenticate: createAuthenticator(config, db), pool, aiEnabled: false, mediaMeasurer: measurer };
    app = createHttpApp(deps);
    const created = await rpc('org/create', 'owner', { name: `Assemble Org ${randomUUID().slice(0, 6)}`, idempotencyKey: randomUUID() }, null);
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

  const userActor = (name: string): UserActor => ({ type: 'user', userId: userIds.get(name)!, aal: 'aal1', mfaAt: null, sessionId: accounts.get(name)!.session });
  // A well-formed record input for the refusals that never reach the sealing.
  const assembleInput = (meetingId: string, over: Record<string, unknown> = {}) => {
    const sha = createHash('sha256').update(randomBytes(16)).digest('hex');
    return { meetingId, keyId: 'k1-assemble-test', wrappedKeyHex: '00'.repeat(60), storageKey: fileKey(orgId, sha), sizeBytes: 100, sha256: sha, contentType: 'audio/webm', lengthSeconds: 15, pieces: 3, lastSeq: 2, ...over };
  };
  const refusedWith = async (run: () => Promise<unknown>, code: string) => {
    const error = await run().then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe(code);
  };

  const windowPassed = (meetingId: string) => rows("UPDATE crove_meetings.meeting SET started_at = now() - interval '5 hours' WHERE id = $1", [meetingId]);
  const click = async (name: string, meetingId: string, bearer?: string) => {
    const res = await app.request(`/api/meetings/${meetingId}/live-assemble`, { method: 'POST', headers: { authorization: `Bearer ${bearer ?? (await token(name))}`, 'x-crove-org': slug } });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  };
  const liveStatus = async (name: string, meetingId: string) => (await rpc('meetings/liveStatus', name, { meetingId })).body as { assemble: { available: boolean; reason: string | null; pieces: number; missing: number[] } };
  const audioRows = (meetingId: string) => count('SELECT 1 FROM crove_meetings.audio_segment WHERE meeting_id = $1', [meetingId]);
  const audioKeys = (meetingId: string) => count("SELECT 1 FROM crove_meetings.media_key WHERE meeting_id = $1 AND kind = 'audio'", [meetingId]);
  const runs = () => count('SELECT 1 FROM crove_kernel.ai_run WHERE org_id = $1', [orgId]);
  const sendAll = async (meetingId: string, seqs: number[], marker = 'p') => {
    for (const seq of seqs) expect((await sendChunk('recorder', meetingId, seq, piece(`${marker}${seq}`, seq))).status).toBe(200);
  };
  const joined = (seqs: number[], marker = 'p') => Buffer.concat(seqs.map((seq) => piece(`${marker}${seq}`, seq)));

  it('joins the pieces in order under a fresh audio key: ciphertext only, the length measured, the pieces discarded, no AI touched', async () => {
    const meetingId = await liveMeeting();
    await sendAll(meetingId, [0, 1, 2, 3], 'join');
    await windowPassed(meetingId);
    expect(await liveStatus('recorder', meetingId)).toMatchObject({ assemble: { available: true, reason: null, pieces: 4, missing: [] } });
    const aiBefore = await runs();
    const liveKeys = (await rows<{ wrapped_key: Buffer }>("SELECT wrapped_key FROM crove_meetings.media_key WHERE meeting_id = $1", [meetingId])).map((r) => r.wrapped_key.toString('hex'));
    const pieceObjects = await chunkObjects(meetingId);
    sandbox.seconds = 61;
    measured.length = 0;

    const done = await click('recorder', meetingId);
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ meetingId, pieces: 4, missing: [], lengthSeconds: 61 });

    // What the sandbox was asked to measure is the pieces' bytes in order, read back from the sealed blob.
    expect(measured).toHaveLength(1);
    expect(measured[0]!.equals(joined([0, 1, 2, 3], 'join'))).toBe(true);
    // The recording is the meeting's audio now: playable, equal to the join, one segment, a fresh key none of the pieces had, the length the sandbox measured.
    expect(await audioRows(meetingId)).toBe(1);
    expect(await audioKeys(meetingId)).toBe(1);
    const audioKey = (await rows<{ wrapped_key: Buffer }>("SELECT wrapped_key FROM crove_meetings.media_key WHERE meeting_id = $1 AND kind = 'audio'", [meetingId]))[0]!;
    expect(liveKeys).not.toContain(audioKey.wrapped_key.toString('hex'));
    expect((await rows<{ length_seconds: number }>('SELECT length_seconds FROM crove_meetings.audio_segment WHERE meeting_id = $1', [meetingId]))[0]!.length_seconds).toBe(61);
    const played = await play('recorder', meetingId, 'audio');
    expect(played.status).toBe(200);
    expect(Buffer.from(await played.arrayBuffer()).equals(joined([0, 1, 2, 3], 'join'))).toBe(true);
    expect((await rpc('meetings/get', 'recorder', { meetingId })).body.hasAudio).toBe(true);
    // Ciphertext only: the stored audio object holds no marker and no container header.
    const object = (await rows<{ storage_key: string }>("SELECT f.storage_key FROM crove_kernel.file f JOIN crove_meetings.audio_segment s ON s.org_id = f.org_id AND s.file_id = f.id WHERE s.meeting_id = $1", [meetingId]))[0]!;
    const stored = Buffer.from(await store.get(object.storage_key));
    expect(stored.includes(Buffer.from('join'))).toBe(false);
    expect(stored.includes(WEBM)).toBe(false);
    // The pieces went in the same commit as the recording: no row, no key, and their objects are swept.
    expect(await chunkCount(meetingId)).toBe(0);
    expect(await liveKeyCount(meetingId)).toBe(0);
    await sweep();
    for (const key of pieceObjects) expect(store.storage.has(key)).toBe(false);
    expect(store.storage.has(object.storage_key)).toBe(true);
    // Nothing is AI: no run was started and the batch transcript starts only on the recorder's click.
    expect(await runs()).toBe(aiBefore);
    // The audit row has ids and counts, no key, address or bytes.
    const audit = await rows<{ detail: Record<string, unknown> }>("SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'meetings.live.assemble_record' AND outcome = 'ok' AND target_id = $2", [orgId, meetingId]);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.detail).toMatchObject({ meetingId, pieces: 4, discarded: 4, missing: 0 });
    expect(JSON.stringify(audit)).not.toMatch(/wrapped|storage|sha256|join/i);
    // Joined: nothing more to join.
    expect((await liveStatus('recorder', meetingId)).assemble).toMatchObject({ available: false, reason: 'audio_recorded' });
    expect((await click('recorder', meetingId)).body.code).toBe('MEDIA_ALREADY_RECORDED');
  });

  it('reports a gap in the pieces and still joins what there is', async () => {
    const meetingId = await liveMeeting();
    await sendAll(meetingId, [0, 1, 3, 4], 'gap');
    await windowPassed(meetingId);
    expect((await liveStatus('recorder', meetingId)).assemble).toEqual({ available: true, reason: null, pieces: 4, missing: [2] });
    measured.length = 0;
    const done = await click('recorder', meetingId);
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ pieces: 4, missing: [2] });
    expect(measured[0]!.equals(joined([0, 1, 3, 4], 'gap'))).toBe(true);
    expect(await audioRows(meetingId)).toBe(1);
    const audit = await rows<{ detail: Record<string, unknown> }>("SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'meetings.live.assemble_record' AND target_id = $2", [orgId, meetingId]);
    expect(audit[0]!.detail).toMatchObject({ missing: 1, missingSeqs: [2] });
  });

  it('refuses before the window has passed, with no pieces, and without the first piece, and stores nothing', async () => {
    const early = await liveMeeting();
    await sendAll(early, [0, 1]);
    const none = await liveMeeting();
    await windowPassed(none);
    // Piece 0 holds the container header: a meeting that lost it cannot be joined, and the pane says why.
    const headless = await liveMeeting();
    await sendAll(headless, [0, 1, 2]);
    await windowPassed(headless);
    await rows('DELETE FROM crove_meetings.live_chunk WHERE meeting_id = $1 AND seq = 0', [headless]);
    // A meeting past its audio date has nothing to join.
    const expired = await liveMeeting();
    await sendAll(expired, [0]);
    await windowPassed(expired);
    await rows(`UPDATE crove_meetings.meeting SET audio_retention_date = ${yesterday} WHERE id = $1`, [expired]);
    const stored = store.storage.size;

    expect((await liveStatus('recorder', early)).assemble).toMatchObject({ available: false, reason: 'still_recording', pieces: 2 });
    const tooEarly = await click('recorder', early);
    expect([tooEarly.status, tooEarly.body.code]).toEqual([409, 'LIVE_STILL_OPEN']);
    expect((await liveStatus('recorder', none)).assemble).toMatchObject({ available: false, reason: 'no_pieces', pieces: 0 });
    const nothing = await click('recorder', none);
    expect([nothing.status, nothing.body.code]).toEqual([404, 'LIVE_NO_PIECES']);
    expect((await liveStatus('recorder', headless)).assemble).toMatchObject({ available: false, reason: 'first_piece_missing', pieces: 2, missing: [0] });
    const noHeader = await click('recorder', headless);
    expect([noHeader.status, noHeader.body.code]).toEqual([409, 'LIVE_FIRST_PIECE_MISSING']);
    expect((await click('recorder', expired)).body.code).toBe('MEDIA_RETENTION_PASSED');

    for (const id of [early, none, headless, expired]) expect(await audioRows(id)).toBe(0);
    expect(store.storage.size).toBe(stored);
    expect(await audioKeys(early)).toBe(0);
  });

  it('is the recorder\'s own click: another member, an owner, an extension token and a meeting that did not opt in get nothing', async () => {
    const meetingId = await liveMeeting();
    await sendAll(meetingId, [0, 1]);
    await windowPassed(meetingId);
    const stored = store.storage.size;
    for (const who of ['attendee', 'otherMember', 'owner']) {
      // A member who may not read the meeting is told it does not exist; one who may read it but did not record it is told no.
      expect([403, 404]).toContain((await click(who, meetingId)).status);
      // They see no piece count either: the status is refused as for a meeting they cannot see, or answers the empty one.
      const seen = (await liveStatus(who, meetingId)).assemble;
      if (seen !== undefined) expect(seen).toEqual({ available: false, reason: 'no_pieces', pieces: 0, missing: [] });
    }
    // An extension token reaches only the routes of its scope list, and this is not one.
    const bearer = `crx_${randomBytes(32).toString('base64url')}`;
    await rows(
      `INSERT INTO crove_kernel.extension_token (org_id, id, user_id, token_hash, device_name, scopes, created_at, expires_at, created_by)
       VALUES ($1, $2, $3, $4, 'Test device', ARRAY['meetings'], now(), now() + interval '30 days', $3)`,
      [orgId, randomUUID(), userIds.get('recorder'), hashExtensionSecret(bearer)],
    );
    expect((await click('recorder', meetingId, bearer)).status).toBeGreaterThanOrEqual(400);
    // The command refuses a caller that did not record the meeting: told it does not exist when they cannot read it, told no when they can.
    const refused = await appRuntime.execute('meetings.live.assemble_record', assembleInput(meetingId, { pieces: 2, lastSeq: 1 }), { actor: userActor('attendee'), orgId }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(refused).toBeInstanceOf(DomainError);
    expect(['FORBIDDEN', 'MEETING_NOT_FOUND']).toContain((refused as DomainError).code);
    const plain = await createMeeting('recorder');
    expect((await click('recorder', plain)).status).toBe(404);
    expect(await audioRows(meetingId)).toBe(0);
    expect(store.storage.size).toBe(stored);
    expect(await chunkCount(meetingId)).toBe(2);
  });

  it('reports a piece whose key is gone as missing, joins the rest, and says so in the answer and the audit', async () => {
    const meetingId = await liveMeeting();
    await sendAll(meetingId, [0, 1, 2, 3], 'key');
    await windowPassed(meetingId);
    await rows("DELETE FROM crove_meetings.media_key WHERE meeting_id = $1 AND kind = 'live:2'", [meetingId]);
    measured.length = 0;
    const done = await click('recorder', meetingId);
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ pieces: 3, missing: [2] });
    expect(measured[0]!.equals(joined([0, 1, 3], 'key'))).toBe(true);
    const audit = await rows<{ detail: Record<string, unknown> }>("SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'meetings.live.assemble_record' AND target_id = $2", [orgId, meetingId]);
    expect(audit[0]!.detail).toMatchObject({ pieces: 3, discarded: 4, missing: 1, missingSeqs: [2] });
  });

  it('refuses a record whose piece set is not the one that was joined, or whose address is not its hash, before writing anything', async () => {
    const meetingId = await liveMeeting();
    await sendAll(meetingId, [0, 1, 2]);
    await windowPassed(meetingId);
    const record = (over: Record<string, unknown>) => appRuntime.execute('meetings.live.assemble_record', assembleInput(meetingId, over), { actor: userActor('recorder'), orgId });
    await refusedWith(() => record({ lastSeq: 5 }), 'LIVE_PIECES_CHANGED');
    await refusedWith(() => record({ pieces: 9 }), 'LIVE_PIECES_CHANGED');
    // A set that holds more than the route joined is refused too (a stale plan), unless the rest is named as leftOut.
    await refusedWith(() => record({ pieces: 2 }), 'LIVE_PIECES_CHANGED');
    await refusedWith(() => record({ pieces: 2, leftOut: [7] }), 'LIVE_PIECES_CHANGED');
    await refusedWith(() => record({ storageKey: fileKey(orgId, 'a'.repeat(64)) }), 'INVALID_STORAGE_KEY');
    expect(await audioRows(meetingId)).toBe(0);
    expect(await audioKeys(meetingId)).toBe(0);
    expect(await chunkCount(meetingId)).toBe(3);
    expect(await liveKeyCount(meetingId)).toBe(3);
  });

  it('drops the sealed join when the sandbox cannot read it, or a piece is gone from the store, and keeps the pieces', async () => {
    const meetingId = await liveMeeting();
    await sendAll(meetingId, [0, 1, 2]);
    await windowPassed(meetingId);
    const stored = store.storage.size;
    sandbox.fail = true;
    try {
      const unreadable = await click('recorder', meetingId);
      expect([unreadable.status, unreadable.body.code]).toEqual([422, 'MEDIA_PROBE_FAILED']);
    } finally {
      sandbox.fail = false;
    }
    expect(store.storage.size).toBe(stored);
    // A piece whose object is gone (the store lost it): the join cannot be made whole, so it is refused and nothing stays.
    const [lost] = await chunkObjects(meetingId);
    const kept = store.storage.get(lost!)!;
    store.storage.delete(lost!);
    const gone = await click('recorder', meetingId);
    expect(gone.status).toBe(409);
    store.storage.set(lost!, kept);
    expect(store.storage.size).toBe(stored);
    expect(await audioRows(meetingId)).toBe(0);
    expect(await chunkCount(meetingId)).toBe(3);
    // Both failures are retryable: with the sandbox back and the object restored the click works.
    expect((await click('recorder', meetingId)).status).toBe(200);
    expect(await audioRows(meetingId)).toBe(1);
  });

  it('stops a join that runs past its time limit or whose pieces exceed the size limit, and keeps nothing', async () => {
    const meetingId = await liveMeeting();
    await sendAll(meetingId, [0, 1, 2]);
    await windowPassed(meetingId);
    const stored = store.storage.size;
    const deps = { runtime: appRuntime, store, broker, measurer, maxBytes: 300 * 1024 * 1024 };
    const input = { actor: userActor('recorder'), orgId, meetingId };
    // A clock that is past the deadline at the first piece.
    let tick = 0;
    await refusedWith(() => assembleLivePieces({ ...deps, deadlineMs: 1000, now: () => (tick += 5000) }, input), 'LIVE_ASSEMBLE_TIMEOUT');
    // A size limit below what the pieces hold is refused before a byte is read.
    await refusedWith(() => assembleLivePieces({ ...deps, maxBytes: 10 }, input), 'FILE_TOO_LARGE');
    expect(store.storage.size).toBe(stored);
    expect(await audioRows(meetingId)).toBe(0);
    expect(await chunkCount(meetingId)).toBe(3);
    // Within its limits the same join works.
    expect((await assembleLivePieces(deps, input)).pieces).toBe(3);
  });

  it('loses cleanly against the final upload in either order: one recording, the loser refused and its object dropped', async () => {
    // The final upload first: the pieces are gone with it, so there is nothing to join.
    const first = await liveMeeting();
    await sendAll(first, [0, 1]);
    await windowPassed(first);
    await upload('recorder', first, 'audio', 'final');
    expect((await liveStatus('recorder', first)).assemble).toMatchObject({ available: false, reason: 'audio_recorded' });
    expect((await click('recorder', first)).body.code).toBe('MEDIA_ALREADY_RECORDED');
    expect(await audioRows(first)).toBe(1);

    // The assembly first: a late final upload is refused as a second recording, its sealed object dropped, the joined recording kept.
    const second = await liveMeeting();
    await sendAll(second, [0, 1]);
    await windowPassed(second);
    expect((await click('recorder', second)).status).toBe(200);
    const objects = store.storage.size;
    const late = await app.request(`/api/meetings/${second}/media?kind=audio`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await token('recorder')}`, 'x-crove-org': slug, 'content-type': 'audio/ogg', 'content-length': String(OGG.byteLength + 20) },
      body: new Uint8Array(Buffer.concat([OGG, Buffer.alloc(8, 0), Buffer.from('late-final-recording'.slice(0, 12))])),
    });
    expect(late.status).toBe(409);
    expect(((await late.json()) as { code?: string }).code).toBe('MEDIA_ALREADY_RECORDED');
    expect(store.storage.size).toBe(objects);
    expect(await audioRows(second)).toBe(1);
    expect(await audioKeys(second)).toBe(1);
  });

  it('serializes a click and a final upload that arrive together: exactly one recording, the pieces gone, no stray object', async () => {
    const meetingId = await liveMeeting();
    await sendAll(meetingId, [0, 1, 2]);
    await windowPassed(meetingId);
    await sweep();
    const before = new Set(store.storage.keys());
    const pieceObjects = await chunkObjects(meetingId);
    // Both wait on the meeting's media lock held here, then run one after the other.
    const holder = new pg.Client({ connectionString: adminUrl });
    await holder.connect();
    let outcomes: Array<{ status: number }>;
    try {
      await holder.query('BEGIN');
      await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`meetings.live:${orgId}:${meetingId}`]);
      const both = Promise.all([click('recorder', meetingId), (async () => ({ status: (await app.request(`/api/meetings/${meetingId}/media?kind=audio`, {
        method: 'POST',
        headers: { authorization: `Bearer ${await token('recorder')}`, 'x-crove-org': slug, 'content-type': 'audio/ogg', 'content-length': String(OGG.byteLength + 8 + 12) },
        body: new Uint8Array(Buffer.concat([OGG, Buffer.alloc(8, 0), Buffer.from('racing-final')])),
      })).status }))()]);
      let waiting = 0;
      for (let i = 0; i < 100 && waiting < 2; i += 1) {
        waiting = await count("SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND wait_event = 'advisory'");
        if (waiting < 2) await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(waiting).toBe(2);
      await holder.query('COMMIT');
      outcomes = await both;
    } finally {
      await holder.end();
    }
    expect(outcomes.map((o) => o.status).sort()).toEqual([200, 409]);
    expect(await audioRows(meetingId)).toBe(1);
    expect(await audioKeys(meetingId)).toBe(1);
    expect(await chunkCount(meetingId)).toBe(0);
    expect(await liveKeyCount(meetingId)).toBe(0);
    await sweep();
    for (const key of pieceObjects) expect(store.storage.has(key)).toBe(false);
    // Exactly one new object (the winner's) stays: the loser's sealed object was dropped.
    expect([...store.storage.keys()].filter((key) => !before.has(key))).toHaveLength(1);
  });

  it('leaves shredding and deleting as they were: the joined audio is shredded at its date and goes with the meeting, the pieces of an unjoined one are shredded as before', async () => {
    const joinedId = await liveMeeting();
    await sendAll(joinedId, [0, 1]);
    await windowPassed(joinedId);
    expect((await click('recorder', joinedId)).status).toBe(200);
    const unjoined = await liveMeeting();
    await sendAll(unjoined, [0, 1]);
    const unjoinedObjects = await chunkObjects(unjoined);
    await sweep();
    const objectOf = async (id: string) => (await rows<{ storage_key: string }>("SELECT f.storage_key FROM crove_kernel.file f JOIN crove_meetings.audio_segment s ON s.org_id = f.org_id AND s.file_id = f.id WHERE s.meeting_id = $1", [id]))[0]!.storage_key;
    const joinedObject = await objectOf(joinedId);
    // The audio date passes for both.
    await rows(`UPDATE crove_meetings.meeting SET audio_retention_date = ${yesterday} WHERE id = ANY($1)`, [[joinedId, unjoined]]);
    await retention();
    await sweep();
    expect(await audioKeys(joinedId)).toBe(0);
    expect(await audioRows(joinedId)).toBe(0);
    expect(await liveKeyCount(unjoined)).toBe(0);
    expect(await chunkCount(unjoined)).toBe(0);
    expect(store.storage.has(joinedObject)).toBe(false);
    for (const key of unjoinedObjects) expect(store.storage.has(key)).toBe(false);
    // Deleting a joined meeting takes its audio and its object.
    const doomed = await liveMeeting();
    await sendAll(doomed, [0, 1]);
    await windowPassed(doomed);
    expect((await click('recorder', doomed)).status).toBe(200);
    const doomedObject = await objectOf(doomed);
    expect((await rpc('meetings/delete', 'recorder', { meetingId: doomed })).status).toBe(200);
    await sweep();
    expect(await audioRows(doomed)).toBe(0);
    expect(await audioKeys(doomed)).toBe(0);
    expect(store.storage.has(doomedObject)).toBe(false);
  });
});

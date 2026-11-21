// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb, createPool } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { kernelCommands, kernelQueries } from '@ludy/kernel';
import {
  BlobNotFoundError,
  BlobTooLargeError,
  DomainError,
  Runtime,
  sha256Hex,
  type BlobStore,
  type CredentialBroker,
  type DirectTransfers,
} from '@ludy/kernel-runtime';
import { financeCommands, financeQueries } from '@ludy/mod-finance';
import { meetingsCommands, meetingsQueries, setMeetingVideoImport } from '@ludy/mod-meetings';
import { createAuthenticator } from '../src/auth.ts';
import { resealCredentials } from '../src/credential-reseal.ts';
import { loadConfig } from '../src/config.ts';
import { ConcurrencyLimiter } from '../src/concurrency.ts';
import { createHttpApp, type HttpDeps } from '../src/http.ts';
import { fakeAudioExtractor, fakeMediaMeasurer } from './fake-media.ts';
import { mediaAudioExtractorFor } from '../src/meetings-extract.ts';
import { mediaMeasurerFor } from '../src/meetings-measure.ts';
import { createSessionStatusSource } from '../src/sessions.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const SECRET = 'test-only-meetings-secret-0123456789-abcdef';
const ISSUER = 'crove-auth-meetings';

const suite = ADMIN ? describe : describe.skip;

class TestBlobStore implements BlobStore {
  readonly storage = new Map<string, { bytes: Uint8Array; contentType: string }>();
  readonly staged = new Map<string, Uint8Array>();

  async put(key: string, bytes: Uint8Array, contentType: string): Promise<string> {
    this.storage.set(key, { bytes: new Uint8Array(bytes), contentType });
    return 'content:' + sha256Hex(bytes);
  }

  async get(key: string): Promise<Uint8Array> {
    const item = this.storage.get(key) ?? (this.staged.has(key) ? { bytes: this.staged.get(key)! } : null);
    if (!item) throw new BlobNotFoundError(key);
    return item.bytes;
  }

  // Every ranged read the playback makes: its length shows how much ciphertext one window holds (#2874).
  readonly ranges: Array<{ key: string; length: number }> = [];

  async getRange(key: string, start: number, end: number): Promise<Uint8Array> {
    this.ranges.push({ key, length: end - start + 1 });
    const bytes = await this.get(key);
    return bytes.subarray(start, end + 1);
  }

  async delete(key: string): Promise<void> {
    this.storage.delete(key);
    this.staged.delete(key);
  }

  readonly direct: DirectTransfers = {
    presignUpload: async (key, maxBytes) => ({
      url: 'memory://test',
      fields: { key },
      expiresAt: new Date(Date.now() + 300_000),
      maxBytes,
    }),
    presignDownload: async () => null,
    readStaged: async (key, maxBytes) => {
      const bytes = this.staged.get(key);
      if (!bytes) throw new BlobNotFoundError(key);
      if (bytes.byteLength > maxBytes) throw new BlobTooLargeError(key, maxBytes);
      return { bytes, sha256: sha256Hex(bytes) };
    },
    // Streamed in pieces of 64 bytes, with the same cap rules as the bucket (#2780).
    openStaged: async (key, maxBytes) => {
      const bytes = this.staged.get(key);
      if (!bytes) throw new BlobNotFoundError(key);
      if (bytes.byteLength > maxBytes) throw new BlobTooLargeError(key, maxBytes);
      this.opened.push(key);
      async function* chunks() {
        for (let at = 0; at < bytes!.byteLength; at += 64) yield bytes!.subarray(at, at + 64);
      }
      return { size: bytes.byteLength, chunks: chunks() };
    },
  };
  // The staged keys read as a stream.
  readonly opened: string[] = [];
}

suite('meetings module database integration tests (#2576)', () => {
  const dbName = `crove_test_meetings_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let store: TestBlobStore;
  let broker: CredentialBroker;
  let app: ReturnType<typeof createHttpApp>;
  let appWithoutMeetings: ReturnType<typeof createHttpApp>;
  let runtime: Runtime;
  let deps: HttpDeps;

  const accounts = new Map<string, { subject: string; email: string; session: string }>();
  const userIds = new Map<string, string>();
  let orgId = '';
  let slug = '';

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  async function token(name: string, mfa = false) {
    let who = accounts.get(name);
    if (!who) {
      who = { subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@meetings.test`, session: randomUUID() };
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
      headers: {
        authorization: `Bearer ${await token(name, mfa)}`,
        'content-type': 'application/json',
        ...(org ? { 'x-crove-org': org } : {}),
      },
      body: JSON.stringify(input === undefined ? {} : { json: input }),
    });
    const body = (await response.json()) as { json?: Record<string, unknown> };
    return { status: response.status, body: (body.json ?? body) as Record<string, unknown> };
  }

  async function claimStagedMedia(name: string, meetingId: string, kind: 'audio' | 'video', uploadId: string) {
    const response = await app.request(`/api/meetings/${meetingId}/media`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await token(name)}`,
        'content-type': 'application/json',
        'x-crove-org': slug,
      },
      body: JSON.stringify({ uploadId, kind }),
    });
    const body = (await response.json()) as Record<string, unknown>;
    return { status: response.status, body };
  }

  async function join(name: string, role: 'member' | 'viewer' | 'admin') {
    await token(name);
    const email = accounts.get(name)?.email;
    const invited = await rpc('org/invite', 'owner', { email, role }, slug, true);
    expect(invited.status).toBe(200);
    const tokenPart = String(invited.body.acceptPath).split('#')[1];
    const accepted = await rpc('invites/accept', name, { token: tokenPart }, null);
    expect(accepted.status).toBe(200);
    const uid = await admin(async (c) => {
      const res = await c.query<{ id: string }>('SELECT id FROM crove_kernel.user_account WHERE email = $1', [email]);
      return res.rows[0]!.id;
    });
    userIds.set(name, uid);
    return uid;
  }

  beforeAll(async () => {
    store = new TestBlobStore();
    broker = {
      keyId: 'k1-meetings-test',
      keyIds: ['k1-meetings-test'],
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

    const appUrl = new URL(adminUrl);
    appUrl.username = 'crove_app';
    appUrl.password = 'test-app-pw';
    pool = createPool({ connectionString: appUrl.toString(), max: 8 });
    const db = createDb(pool);

    const config = loadConfig({
      DATABASE_URL: appUrl.toString(),
      AUTH_JWT_SECRET: SECRET,
      AUTH_ISSUER: ISSUER,
      AUTH_SESSION_CHECK: 'off',
      MIGRATIONS_DIR: MIGRATIONS,
      WEB_DIST: '/nonexistent',
    });

    runtime = new Runtime(db, {
      manifests: TEST_MANIFESTS,
      sessions: createSessionStatusSource('off'),
      stepUp: 'required',
    }).register({
      commands: [
        ...kernelCommands,
        ...financeCommands,
        ...meetingsCommands,
      ],
      queries: [
        ...kernelQueries({ inboundDomain: null }),
        ...financeQueries,
        ...meetingsQueries,
      ],
    });

    deps = {
      config,
      runtime,
      store,
      broker,
      authenticate: createAuthenticator(config, db),
      pool,
      aiEnabled: false,
      mediaMeasurer: fakeMediaMeasurer(),
    };
    app = createHttpApp(deps);

    const runtimeNoMeetings = new Runtime(db, {
      manifests: TEST_MANIFESTS.filter((m) => !('crove_meetings' in m)),
      sessions: createSessionStatusSource('off'),
      stepUp: 'required',
    }).register({
      commands: [...kernelCommands, ...financeCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries],
    });
    appWithoutMeetings = createHttpApp({
      ...deps,
      runtime: runtimeNoMeetings,
    });

    const created = await rpc('org/create', 'owner', { name: `Meetings Test Org ${randomUUID().slice(0, 6)}`, idempotencyKey: randomUUID() }, null);
    expect(created.status).toBe(200);
    slug = String(created.body.slug);
    orgId = String(created.body.orgId);
    const ownerEmail = accounts.get('owner')?.email;
    const ownerUid = await admin(async (c) => {
      const res = await c.query<{ id: string }>('SELECT id FROM crove_kernel.user_account WHERE email = $1', [ownerEmail]);
      return res.rows[0]!.id;
    });
    userIds.set('owner', ownerUid);

    await join('recorder', 'member');
    await join('attendee', 'member');
    await join('otherMember', 'member');
    await join('viewer', 'viewer');
  });

  afterAll(async () => {
    await pool?.end();
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('1. meeting creation with consent confirmation and reader assignment', async () => {
    // Assert crove_meetings.media_key has RLS enabled (relrowsecurity = true) and NEVER forced (relforcerowsecurity = false)
    const mediaKeyRls = await admin(async (c) =>
      (await c.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        `SELECT relrowsecurity, relforcerowsecurity FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'crove_meetings' AND c.relname = 'media_key'`,
      )).rows[0],
    );
    expect(mediaKeyRls?.relrowsecurity).toBe(true);
    expect(mediaKeyRls?.relforcerowsecurity).toBe(false);

    const attendeeId = userIds.get('attendee')!;
    const viewerId = userIds.get('viewer')!;

    // Passing a viewer as a reader must be rejected with INVALID_READER
    const viewerCreate = await rpc('meetings/create', 'recorder', {
      title: 'Invalid Reader Meeting',
      visibility: 'attendees',
      consentMethod: 'told_at_start',
      readerUserIds: [viewerId],
    });
    expect(viewerCreate.status).toBe(400);

    // Creating meeting with attendee succeeds
    const createRes = await rpc('meetings/create', 'recorder', {
      title: 'Weekly Standup',
      language: 'vi',
      visibility: 'attendees',
      keepVideo: true,
      consentMethod: 'told_at_start',
      readerUserIds: [attendeeId],
    });
    expect(createRes.status).toBe(200);
    const meetingId = String(createRes.body.meetingId);
    expect(meetingId).toBeDefined();

    // Verify row in database
    const meetingRow = await admin(async (c) =>
      (await c.query('SELECT * FROM crove_meetings.meeting WHERE id = $1', [meetingId])).rows[0],
    );
    expect(meetingRow).toBeDefined();
    expect(meetingRow.title).toBe('Weekly Standup');
    expect(meetingRow.consent_method).toBe('told_at_start');
    expect(meetingRow.recorder_user_id).toBe(userIds.get('recorder'));

    // Verify reader row
    const readers = await admin(async (c) =>
      (await c.query('SELECT user_id FROM crove_meetings.meeting_reader WHERE meeting_id = $1', [meetingId])).rows,
    );
    expect(readers.map((r) => r.user_id)).toContain(attendeeId);
  });

  it('2. media claim with encryption, magic container validation, and key sealing', async () => {
    const attendeeId = userIds.get('attendee')!;
    const createRes = await rpc('meetings/create', 'recorder', {
      title: 'Quarterly Review',
      visibility: 'attendees',
      keepVideo: true,
      consentMethod: 'in_invite',
      readerUserIds: [attendeeId],
    });
    expect(createRes.status).toBe(200);
    const meetingId = String(createRes.body.meetingId);

    // Staged audio upload with valid OggS header
    const audioUploadId = randomUUID();
    const stagingKeyAudio = `staging/${randomBytes(32).toString('hex')}`;
    const rawAudioBytes = Buffer.concat([
      Buffer.from([0x4f, 0x67, 0x67, 0x53, 0x00, 0x02]), // OggS
      Buffer.alloc(100, 0x24),
    ]);
    store.staged.set(stagingKeyAudio, rawAudioBytes);

    await admin(async (c) => {
      await c.query(
        `INSERT INTO crove_kernel.file_upload (org_id, id, staging_key, created_by, max_bytes, purpose, created_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, 'meeting_audio', now(), now() + interval '5 minutes')`,
        [orgId, audioUploadId, stagingKeyAudio, userIds.get('recorder'), 300 * 1024 * 1024],
      );
    });

    // Attempt claim with invalid container bytes (e.g. 0x41)
    const invalidUploadId = randomUUID();
    const stagingKeyInvalid = `staging/${randomBytes(32).toString('hex')}`;
    store.staged.set(stagingKeyInvalid, Buffer.alloc(100, 0x41));
    await admin(async (c) => {
      await c.query(
        `INSERT INTO crove_kernel.file_upload (org_id, id, staging_key, created_by, max_bytes, purpose, created_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, 'meeting_audio', now(), now() + interval '5 minutes')`,
        [orgId, invalidUploadId, stagingKeyInvalid, userIds.get('recorder'), 300 * 1024 * 1024],
      );
    });
    const invalidClaim = await claimStagedMedia('recorder', meetingId, 'audio', invalidUploadId);
    expect(invalidClaim.status).toBe(400);
    expect(store.staged.has(stagingKeyInvalid)).toBe(false);

    // Valid claim audio
    const claimAudioRes = await claimStagedMedia('recorder', meetingId, 'audio', audioUploadId);
    expect(claimAudioRes.status).toBe(200);
    expect(store.staged.has(stagingKeyAudio)).toBe(false);
    const audioFileId = String(claimAudioRes.body.fileId);

    // Check crove_kernel.file and crove_meetings.media_key
    const fileRow = await admin(async (c) =>
      (await c.query('SELECT * FROM crove_kernel.file WHERE id = $1', [audioFileId])).rows[0],
    );
    expect(fileRow.source).toBe('meeting_audio');
    expect(fileRow.generation).toBeDefined();

    const mediaKeyRow = await admin(async (c) =>
      (await c.query('SELECT * FROM crove_meetings.media_key WHERE meeting_id = $1 AND kind = $2', [meetingId, 'audio'])).rows[0],
    );
    expect(mediaKeyRow).toBeDefined();
    expect(mediaKeyRow.wrapped_key).toBeDefined();

    // Staged video upload with valid MP4 ftyp header
    const videoUploadId = randomUUID();
    const stagingKeyVideo = `staging/${randomBytes(32).toString('hex')}`;
    const rawVideoBytes = Buffer.concat([
      Buffer.from([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70]), // ftyp at byte 4
      Buffer.alloc(200, 0x77),
    ]);
    store.staged.set(stagingKeyVideo, rawVideoBytes);

    await admin(async (c) => {
      await c.query(
        `INSERT INTO crove_kernel.file_upload (org_id, id, staging_key, created_by, max_bytes, purpose, created_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, 'meeting_video', now(), now() + interval '5 minutes')`,
        [orgId, videoUploadId, stagingKeyVideo, userIds.get('recorder'), 2 * 1024 * 1024 * 1024],
      );
    });

    const claimVideoRes = await claimStagedMedia('recorder', meetingId, 'video', videoUploadId);
    expect(claimVideoRes.status).toBe(200);
    expect(store.staged.has(stagingKeyVideo)).toBe(false);
  });

  it('3. playback queries and Range chunk streaming (200, 206, 416)', async () => {
    const attendeeId = userIds.get('attendee')!;
    const createRes = await rpc('meetings/create', 'recorder', {
      title: 'Range Playback Meeting',
      visibility: 'attendees',
      keepVideo: false,
      consentMethod: 'told_at_start',
      readerUserIds: [attendeeId],
    });
    const meetingId = String(createRes.body.meetingId);

    // Audio bytes with 200 bytes
    const originalAudio = Buffer.concat([
      Buffer.from([0x4f, 0x67, 0x67, 0x53, 0x00, 0x02]), // OggS
      Buffer.from('abcdefghijklmnopqrstuvwxyz0123456789'.repeat(10)),
    ]);
    const audioUploadId = randomUUID();
    const stagingKey = `staging/${randomBytes(32).toString('hex')}`;
    store.staged.set(stagingKey, originalAudio);

    await admin(async (c) => {
      await c.query(
        `INSERT INTO crove_kernel.file_upload (org_id, id, staging_key, created_by, max_bytes, purpose, created_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, 'meeting_audio', now(), now() + interval '5 minutes')`,
        [orgId, audioUploadId, stagingKey, userIds.get('recorder'), 300 * 1024 * 1024],
      );
    });

    const uploadedRes = await claimStagedMedia('recorder', meetingId, 'audio', audioUploadId);
    expect(uploadedRes.status).toBe(200);

    // HTTP 200 full playback
    const fullRes = await app.request(`/api/meetings/${meetingId}/audio`, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${await token('recorder')}`,
        'x-crove-org': slug,
      },
    });
    expect(fullRes.status).toBe(200);
    expect(fullRes.headers.get('x-content-type-options')).toBe('nosniff');
    expect(fullRes.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
    const fullBody = Buffer.from(await fullRes.arrayBuffer());
    expect(fullBody.equals(originalAudio)).toBe(true);

    const auditCountAfterFull = await admin(async (c) =>
      Number((await c.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM crove_kernel.audit_event
         WHERE org_id = $1 AND command = 'meetings.meeting.audio_read' AND target_id = $2`,
        [orgId, meetingId],
      )).rows[0]!.count),
    );
    expect(auditCountAfterFull).toBe(1);

    // HTTP 206 Partial Content (bytes 10-25). The attendee's first request is the audited read whatever its Range, so a
    // reader cannot skip the audit by starting at an offset; the next ranges of the same playback add no row.
    const rangeRes = await app.request(`/api/meetings/${meetingId}/audio`, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${await token('attendee')}`,
        'x-crove-org': slug,
        range: 'bytes=10-25',
      },
    });
    expect(rangeRes.status).toBe(206);
    expect(rangeRes.headers.get('content-range')).toBe(`bytes 10-25/${originalAudio.length}`);
    const rangeBody = Buffer.from(await rangeRes.arrayBuffer());
    expect(rangeBody.equals(originalAudio.subarray(10, 26))).toBe(true);

    const auditCountAfterMidRange = await admin(async (c) =>
      Number((await c.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM crove_kernel.audit_event
         WHERE org_id = $1 AND command = 'meetings.meeting.audio_read' AND target_id = $2`,
        [orgId, meetingId],
      )).rows[0]!.count),
    );
    expect(auditCountAfterMidRange).toBe(2);

    // HTTP 206 Suffix Range (bytes -20)
    const suffixRes = await app.request(`/api/meetings/${meetingId}/audio`, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${await token('attendee')}`,
        'x-crove-org': slug,
        range: 'bytes=-20',
      },
    });
    expect(suffixRes.status).toBe(206);
    const expectedSuffixStart = originalAudio.length - 20;
    expect(suffixRes.headers.get('content-range')).toBe(`bytes ${expectedSuffixStart}-${originalAudio.length - 1}/${originalAudio.length}`);
    const suffixBody = Buffer.from(await suffixRes.arrayBuffer());
    expect(suffixBody.equals(originalAudio.subarray(expectedSuffixStart))).toBe(true);

    // HTTP 416 Range Not Satisfiable
    const invalidRangeRes = await app.request(`/api/meetings/${meetingId}/audio`, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${await token('attendee')}`,
        'x-crove-org': slug,
        range: 'bytes=999999-',
      },
    });
    expect(invalidRangeRes.status).toBe(416);
  });

  it('4. RLS isolation: attendees-only vs org-wide, viewer rejection, non-reader rejection', async () => {
    const attendeeId = userIds.get('attendee')!;
    // Attendees-only meeting
    const attRes = await rpc('meetings/create', 'recorder', {
      title: 'Secret Attendees Meeting',
      visibility: 'attendees',
      consentMethod: 'told_at_start',
      readerUserIds: [attendeeId],
    });
    const attMeetingId = String(attRes.body.meetingId);

    // Non-reader member listing meetings: does not see Secret Attendees Meeting
    const otherList = await rpc('meetings/list', 'otherMember', {});
    expect(otherList.status).toBe(200);
    const otherMeetings = (otherList.body as unknown as Array<{ id: string }>);
    expect(otherMeetings.some((m) => m.id === attMeetingId)).toBe(false);

    // Non-reader member fetching meeting directly: 404
    const otherGet = await rpc('meetings/get', 'otherMember', { meetingId: attMeetingId });
    expect(otherGet.status).toBe(404);

    // Viewer listing meetings: rejected with 403 (viewers have no access)
    const viewerList = await rpc('meetings/list', 'viewer', {});
    expect(viewerList.status).toBe(403);

    // Org-wide meeting
    const orgRes = await rpc('meetings/create', 'recorder', {
      title: 'All Hands Meeting',
      visibility: 'org',
      consentMethod: 'told_at_start',
    });
    const orgMeetingId = String(orgRes.body.meetingId);

    // Non-reader member CAN see All Hands Meeting
    const otherOrgList = await rpc('meetings/list', 'otherMember', {});
    const visibleMeetings = (otherOrgList.body as unknown as Array<{ id: string }>);
    expect(visibleMeetings.some((m) => m.id === orgMeetingId)).toBe(true);
  });

  it('5. recorder delete (R1) vs owner compliance delete (R3)', async () => {
    const attendeeId = userIds.get('attendee')!;
    // Meeting 1: for recorder delete (org visibility so otherMember can see it)
    const m1 = await rpc('meetings/create', 'recorder', {
      title: 'Meeting To Delete By Recorder',
      visibility: 'org',
      consentMethod: 'told_at_start',
    });
    const m1Id = String(m1.body.meetingId);

    // Another member attempting to delete: 403 FORBIDDEN
    const forbiddenDelete = await rpc('meetings/delete', 'otherMember', { meetingId: m1Id });
    expect(forbiddenDelete.status).toBe(403);

    // Recorder deletes: 200 OK
    const recorderDelete = await rpc('meetings/delete', 'recorder', { meetingId: m1Id });
    expect(recorderDelete.status).toBe(200);

    // Meeting 2: for owner compliance delete
    const m2 = await rpc('meetings/create', 'recorder', {
      title: 'Meeting For Owner Delete',
      visibility: 'attendees',
      consentMethod: 'told_at_start',
      readerUserIds: [attendeeId],
    });
    const m2Id = String(m2.body.meetingId);

    // Non-owner attempting owner delete: 403
    const nonOwnerDelete = await rpc('meetings/ownerDelete', 'attendee', { meetingId: m2Id });
    expect(nonOwnerDelete.status).toBe(403);

    // Owner performs compliance delete (R3 requires MFA): 200 OK
    const ownerDelete = await rpc('meetings/ownerDelete', 'owner', { meetingId: m2Id }, slug, true);
    expect(ownerDelete.status).toBe(200);

    // Check database: both deleted
    const count = await admin(async (c) =>
      (await c.query('SELECT count(*) FROM crove_meetings.meeting WHERE id IN ($1, $2)', [m1Id, m2Id])).rows[0].count,
    );
    expect(Number(count)).toBe(0);
  });

  it('6. key shredding: media key unreadable after deletion', async () => {
    const createRes = await rpc('meetings/create', 'recorder', {
      title: 'Shred Test Meeting',
      visibility: 'attendees',
      consentMethod: 'told_at_start',
    });
    const meetingId = String(createRes.body.meetingId);

    const uploadId = randomUUID();
    const stagingKey = `staging/${randomBytes(32).toString('hex')}`;
    store.staged.set(stagingKey, Buffer.concat([Buffer.from([0x4f, 0x67, 0x67, 0x53, 0x00, 0x02]), Buffer.alloc(50)]));
    await admin(async (c) => {
      await c.query(
        `INSERT INTO crove_kernel.file_upload (org_id, id, staging_key, created_by, max_bytes, purpose, created_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, 'meeting_audio', now(), now() + interval '5 minutes')`,
        [orgId, uploadId, stagingKey, userIds.get('recorder'), 300 * 1024 * 1024],
      );
    });
    const shredClaimRes = await claimStagedMedia('recorder', meetingId, 'audio', uploadId);
    expect(shredClaimRes.status).toBe(200);

    // Verify key exists before deletion
    const beforeKeys = await admin(async (c) =>
      (await c.query('SELECT * FROM crove_meetings.media_key WHERE meeting_id = $1', [meetingId])).rows,
    );
    expect(beforeKeys.length).toBeGreaterThan(0);

    // Delete meeting
    await rpc('meetings/delete', 'recorder', { meetingId });

    // Verify media_key row was shredded / deleted
    const afterKeys = await admin(async (c) =>
      (await c.query('SELECT * FROM crove_meetings.media_key WHERE meeting_id = $1', [meetingId])).rows,
    );
    expect(afterKeys.length).toBe(0);

    // Playback returns 404
    const playbackRes = await app.request(`/api/meetings/${meetingId}/audio`, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${await token('recorder')}`,
        'x-crove-org': slug,
      },
    });
    expect(playbackRes.status).toBe(404);
  });

  it('7. CROVE_MODULES without meetings returns 404 on playback and upload purpose', async () => {
    const disabledRes = await appWithoutMeetings.request(`/api/meetings/${randomUUID()}/audio`, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${await token('recorder')}`,
        'x-crove-org': slug,
      },
    });
    expect(disabledRes.status).toBe(404);
  });

  it('8. purpose binding prevents meeting upload bypass on /complete', async () => {
    // Staged upload created with meeting_audio purpose
    const meetingUploadId = randomUUID();
    const stagingKey = `staging/${randomBytes(32).toString('hex')}`;
    store.staged.set(stagingKey, Buffer.from([0x4f, 0x67, 0x67, 0x53, 0x00, 0x02, 0x00]));

    await admin(async (c) => {
      await c.query(
        `INSERT INTO crove_kernel.file_upload (org_id, id, staging_key, created_by, max_bytes, purpose, created_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, 'meeting_audio', now(), now() + interval '5 minutes')`,
        [orgId, meetingUploadId, stagingKey, userIds.get('recorder'), 300 * 1024 * 1024],
      );
    });

    // 1. Calling /complete with purpose 'meeting_audio' is rejected
    const rejectDirectMeeting = await app.request(`/api/files/uploads/${meetingUploadId}/complete`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await token('recorder')}`,
        'x-crove-org': slug,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ purpose: 'meeting_audio', filename: 'audio.ogg' }),
    });
    expect(rejectDirectMeeting.status).toBe(400);
    // Refused before the claim: the grant is unused, so its staged object stays for POST /api/meetings/:id/media.
    expect(store.staged.has(stagingKey)).toBe(true);

    // 2. Calling /complete with purpose 'document' to bypass encryption is rejected due to purpose mismatch
    const bypassAttempt = await app.request(`/api/files/uploads/${meetingUploadId}/complete`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await token('recorder')}`,
        'x-crove-org': slug,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ purpose: 'document', filename: 'sneaky.ogg' }),
    });
    expect(bypassAttempt.status).toBe(400);
    // The claim used the grant up, so the refusal must not leave the staged object behind (#2780).
    expect(store.staged.has(stagingKey)).toBe(false);
  });

  it('9. POST /api/meetings/:id/media handles direct upload (STORAGE=local) and Range continuation chunks', async () => {
    const createRes = await rpc('meetings/create', 'recorder', {
      title: 'Direct Media Upload Meeting',
      visibility: 'attendees',
      keepVideo: true,
      consentMethod: 'told_at_start',
    });
    const meetingId = String(createRes.body.meetingId);

    // Direct multipart/form-data upload for STORAGE=local
    const audioContent = Buffer.concat([
      Buffer.from([0x4f, 0x67, 0x67, 0x53, 0x00, 0x02]), // OggS
      Buffer.from('0123456789'.repeat(30)),
    ]);
    const formData = new FormData();
    formData.append('kind', 'audio');
    formData.append('file', new Blob([audioContent], { type: 'audio/ogg' }), 'recording.ogg');

    const directUploadRes = await app.request(`/api/meetings/${meetingId}/media`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await token('recorder')}`,
        'x-crove-org': slug,
      },
      body: formData,
    });
    expect(directUploadRes.status).toBe(200);
    const body = (await directUploadRes.json()) as { fileId: string };
    expect(body.fileId).toBeDefined();

    // Range playback with start > 0 (continuation scrub chunk)
    const rangeRes = await app.request(`/api/meetings/${meetingId}/audio`, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${await token('recorder')}`,
        'x-crove-org': slug,
        range: 'bytes=10-40',
      },
    });
    expect(rangeRes.status).toBe(206);
    expect(rangeRes.headers.get('content-range')).toContain('bytes 10-40/');
    const rangeSlice = Buffer.from(await rangeRes.arrayBuffer());
    expect(rangeSlice.equals(audioContent.subarray(10, 41))).toBe(true);

    // Compliance owner delete shreds media key and removes meeting (R3 requires fresh MFA: true)
    const ownerDeleteRes = await rpc('meetings/ownerDelete', 'owner', { meetingId }, slug, true);
    expect(ownerDeleteRes.status).toBe(200);

    const keysLeft = await admin(async (c) =>
      (await c.query('SELECT * FROM crove_meetings.media_key WHERE meeting_id = $1', [meetingId])).rows,
    );
    expect(keysLeft.length).toBe(0);
  });

  it('10. acceptance: no consent, no upload; ciphertext at rest; a non-reader gets nothing; a shredded key cannot decrypt', async () => {
    // No consent record: the create is refused, so there is no meeting to attach media to.
    const noConsent = await rpc('meetings/create', 'recorder', { title: 'No consent', visibility: 'attendees' });
    expect(noConsent.status).toBe(400);
    const badConsent = await rpc('meetings/create', 'recorder', { title: 'Bad consent', visibility: 'attendees', consentMethod: 'whatever' });
    expect(badConsent.status).toBe(400);

    const createRes = await rpc('meetings/create', 'recorder', { title: 'Private', visibility: 'attendees', consentMethod: 'in_invite' });
    expect(createRes.status).toBe(200);
    const meetingId = String(createRes.body.meetingId);
    const marker = Buffer.from('PLAINTEXT-MARKER-0123456789'.repeat(20));
    const audio = Buffer.concat([Buffer.from([0x4f, 0x67, 0x67, 0x53, 0x00, 0x02]), marker]);
    const upload = async (name: string) => {
      const form = new FormData();
      form.append('kind', 'audio');
      form.append('file', new Blob([audio], { type: 'audio/ogg' }), 'a.ogg');
      return app.request(`/api/meetings/${meetingId}/media`, { method: 'POST', headers: { authorization: `Bearer ${await token(name)}`, 'x-crove-org': slug }, body: form });
    };
    // Only the recorder may upload.
    expect((await upload('otherMember')).status).toBeGreaterThanOrEqual(400);
    expect((await upload('recorder')).status).toBe(200);

    // The stored bytes are ciphertext: none of the stored objects holds the plaintext marker or starts as an Ogg stream.
    const stored = [...store.storage.values()].map((o) => Buffer.from(o.bytes));
    expect(stored.length).toBeGreaterThan(0);
    for (const bytes of stored) {
      expect(bytes.includes(marker.subarray(0, 24))).toBe(false);
    }

    // A member who is not a reader gets nothing over HTTP, and neither does a viewer.
    for (const name of ['otherMember', 'viewer']) {
      const res = await app.request(`/api/meetings/${meetingId}/audio`, { headers: { authorization: `Bearer ${await token(name)}`, 'x-crove-org': slug } });
      expect(res.status, name).toBeGreaterThanOrEqual(400);
      expect(Buffer.from(await res.arrayBuffer()).includes(marker.subarray(0, 24)), name).toBe(false);
    }
    const ok = await app.request(`/api/meetings/${meetingId}/audio`, { headers: { authorization: `Bearer ${await token('recorder')}`, 'x-crove-org': slug } });
    expect(ok.status).toBe(200);
    expect(Buffer.from(await ok.arrayBuffer()).equals(audio)).toBe(true);

    // Shred only the key (the meeting and the blob stay): the audio no longer decrypts, so the route answers 404.
    await admin(async (c) => {
      await c.query('DELETE FROM crove_meetings.media_key WHERE meeting_id = $1', [meetingId]);
    });
    expect(store.storage.size).toBeGreaterThan(0);
    const shredded = await app.request(`/api/meetings/${meetingId}/audio`, { headers: { authorization: `Bearer ${await token('recorder')}`, 'x-crove-org': slug } });
    expect(shredded.status).toBe(404);
  });

  it('11. a key rotation reseals the media keys through the system command, and the audio still plays', async () => {
    const createRes = await rpc('meetings/create', 'recorder', { title: 'Rotation', visibility: 'attendees', consentMethod: 'told_at_start' });
    const meetingId = String(createRes.body.meetingId);
    const audio = Buffer.concat([Buffer.from([0x4f, 0x67, 0x67, 0x53, 0x00, 0x02]), Buffer.from('rotation-audio-bytes'.repeat(10))]);
    const form = new FormData();
    form.append('kind', 'audio');
    form.append('file', new Blob([audio], { type: 'audio/ogg' }), 'a.ogg');
    const up = await app.request(`/api/meetings/${meetingId}/media`, { method: 'POST', headers: { authorization: `Bearer ${await token('recorder')}`, 'x-crove-org': slug }, body: form });
    expect(up.status).toBe(200);

    const workerUrl = new URL(adminUrl);
    workerUrl.username = 'crove_worker';
    workerUrl.password = 'test-worker-pw';
    const workerPool = createPool({ connectionString: workerUrl.toString(), max: 4 });
    try {
      const workerDb = createDb(workerPool);
      const worker = new Runtime(workerDb, { manifests: TEST_MANIFESTS }).register({
        commands: [...kernelCommands, ...financeCommands, ...meetingsCommands],
        queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries, ...meetingsQueries],
      });
      const rotated = { ...broker, keyId: 'k2-meetings-test', keyIds: ['k2-meetings-test', 'k1-meetings-test'] } as unknown as CredentialBroker;
      const outcome = await resealCredentials({ runtime: worker, broker: rotated, workerDb });
      expect(outcome.failed).toBe(0);
      expect(outcome.resealed).toBeGreaterThanOrEqual(1);
      const row = await admin(async (c) => (await c.query<{ key_id: string }>('SELECT key_id FROM crove_meetings.media_key WHERE meeting_id = $1', [meetingId])).rows[0]);
      expect(row?.key_id).toBe('k2-meetings-test');
      const audits = await admin(async (c) => Number((await c.query<{ n: string }>("SELECT count(*)::text AS n FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'meetings.media_key.reseal'", [orgId])).rows[0]!.n));
      expect(audits).toBeGreaterThanOrEqual(1);
    } finally {
      await workerPool.end();
    }
    const play = await app.request(`/api/meetings/${meetingId}/audio`, { headers: { authorization: `Bearer ${await token('recorder')}`, 'x-crove-org': slug } });
    expect(play.status).toBe(200);
    expect(Buffer.from(await play.arrayBuffer()).equals(audio)).toBe(true);
  });

  it('13. the length is what crove-media measures, never what the client says (#2985)', async () => {
    const createRes = await rpc('meetings/create', 'recorder', { title: 'Measured length', visibility: 'attendees', consentMethod: 'told_at_start' });
    const meetingId = String(createRes.body.meetingId);
    const audio = Buffer.concat([Buffer.from([0x4f, 0x67, 0x67, 0x53, 0x00, 0x02]), Buffer.from('measure-me-'.repeat(200))]);
    const seen: Buffer[] = [];
    const measuring = createHttpApp({
      ...deps,
      mediaMeasurer: {
        configured: true,
        measure: async (_kind, source) => {
          for await (const piece of source) seen.push(Buffer.from(piece));
          return 1800;
        },
        measureBytes: async () => 1800,
      },
    });
    const form = new FormData();
    form.append('kind', 'audio');
    form.append('lengthSeconds', '60');
    form.append('file', new Blob([audio], { type: 'audio/ogg' }), 'a.ogg');
    const up = await measuring.request(`/api/meetings/${meetingId}/media`, { method: 'POST', headers: { authorization: `Bearer ${await token('recorder')}`, 'x-crove-org': slug }, body: form });
    expect(up.status).toBe(200);
    // The sandbox was sent the plaintext, whole and in order, read back from the sealed blob.
    expect(Buffer.concat(seen).equals(audio)).toBe(true);
    const rows = await admin(async (c) => (await c.query<{ length_seconds: number }>('SELECT length_seconds FROM crove_meetings.audio_segment WHERE meeting_id = $1', [meetingId])).rows);
    expect(rows.map((r) => r.length_seconds)).toEqual([1800]);
  });

  it('14. without the sandbox, or with a file it refuses, nothing is stored (#2985)', async () => {
    const createRes = await rpc('meetings/create', 'recorder', { title: 'No sandbox', visibility: 'attendees', consentMethod: 'told_at_start' });
    const meetingId = String(createRes.body.meetingId);
    const audio = Buffer.concat([Buffer.from([0x4f, 0x67, 0x67, 0x53, 0x00, 0x02]), Buffer.from('hostile-'.repeat(100))]);
    const send = async (target: ReturnType<typeof createHttpApp>) => {
      const form = new FormData();
      form.append('kind', 'audio');
      form.append('file', new Blob([audio], { type: 'audio/ogg' }), 'a.ogg');
      return target.request(`/api/meetings/${meetingId}/media`, { method: 'POST', headers: { authorization: `Bearer ${await token('recorder')}`, 'x-crove-org': slug }, body: form });
    };
    const objectsBefore = store.storage.size;
    const files = async () => admin(async (c) => Number((await c.query<{ n: string }>("SELECT count(*)::text AS n FROM crove_kernel.file WHERE org_id = $1 AND source = 'meeting_audio'", [orgId])).rows[0]!.n));
    const filesBefore = await files();

    // MEDIA_URL unset: refused before a byte is stored.
    const unset = await send(createHttpApp({ ...deps, mediaMeasurer: mediaMeasurerFor(undefined) }));
    expect(unset.status).toBe(503);
    expect(((await unset.json()) as { code?: string }).code).toBe('MEDIA_PROBE_UNAVAILABLE');

    // A file the sandbox cannot read: refused, and the sealed blob it was about to measure is deleted again.
    const hostile = await send(
      createHttpApp({
        ...deps,
        mediaMeasurer: {
          configured: true,
          measure: async (_kind, source) => {
            for await (const piece of source) void piece;
            throw new DomainError('MEDIA_PROBE_FAILED', 422, 'The recording could not be read');
          },
          measureBytes: async () => 0,
        },
      }),
    );
    expect(hostile.status).toBe(422);
    expect(((await hostile.json()) as { code?: string }).code).toBe('MEDIA_PROBE_FAILED');

    expect(store.storage.size).toBe(objectsBefore);
    expect(await files()).toBe(filesBefore);
    const segments = await admin(async (c) => Number((await c.query<{ n: string }>('SELECT count(*)::text AS n FROM crove_meetings.audio_segment WHERE meeting_id = $1', [meetingId])).rows[0]!.n));
    expect(segments).toBe(0);
  });

  it('15. a deployment cap on crove-media is the cap of the upload: refused before it is read, with the cap in the message (#2989)', async () => {
    const createRes = await rpc('meetings/create', 'recorder', { title: 'Deployment cap', visibility: 'attendees', consentMethod: 'told_at_start' });
    const meetingId = String(createRes.body.meetingId);
    const cap = 2 * 1024 * 1024;
    const capped = createHttpApp({ ...deps, config: { ...deps.config, MEDIA_MAX_INPUT_BYTES: cap }, mediaMeasurer: fakeMediaMeasurer() });
    const big = Buffer.concat([Buffer.from([0x4f, 0x67, 0x67, 0x53, 0x00, 0x02]), Buffer.alloc(cap, 0x61)]);
    const headers = async (extra: Record<string, string> = {}) => ({ authorization: `Bearer ${await token('recorder')}`, 'x-crove-org': slug, ...extra });
    const objectsBefore = store.storage.size;
    // Multipart: refused by size, naming the cap in force, not the plan's 300 MB.
    const form = new FormData();
    form.append('kind', 'audio');
    form.append('file', new Blob([big], { type: 'audio/ogg' }), 'big.ogg');
    const multipart = await capped.request(`/api/meetings/${meetingId}/media`, { method: 'POST', headers: await headers(), body: form });
    expect(multipart.status).toBe(413);
    const multipartBody = (await multipart.json()) as { code?: string; message?: string; error?: string };
    expect(multipartBody.code).toBe('FILE_TOO_LARGE');
    expect(JSON.stringify(multipartBody)).toContain('2 MB');
    expect(JSON.stringify(multipartBody)).not.toContain('300 MB');
    // The raw body: its Content-Length is over the cap, so it is refused before one byte is sealed.
    const raw = await capped.request(`/api/meetings/${meetingId}/media?kind=audio`, { method: 'POST', headers: await headers({ 'content-type': 'audio/ogg', 'content-length': String(big.length) }), body: big });
    expect(raw.status).toBe(413);
    expect(((await raw.json()) as { code?: string }).code).toBe('FILE_TOO_LARGE');
    expect(store.storage.size).toBe(objectsBefore);
    // The same file is within the default cap (300 MB audio): it stores.
    const accepted = new FormData();
    accepted.append('kind', 'audio');
    accepted.append('file', new Blob([big], { type: 'audio/ogg' }), 'big.ogg');
    expect((await app.request(`/api/meetings/${meetingId}/media`, { method: 'POST', headers: await headers(), body: accepted })).status).toBe(200);
  });

  it('12. a long playback stops when the meeting is deleted after its first window', async () => {
    const createRes = await rpc('meetings/create', 'recorder', { title: 'Delete During Playback', visibility: 'attendees', consentMethod: 'told_at_start' });
    const meetingId = String(createRes.body.meetingId);
    // Over two 4 MiB stream windows, so the body is streamed and each window after the first asks again whether the meeting lives.
    const audio = Buffer.concat([Buffer.from([0x4f, 0x67, 0x67, 0x53, 0x00, 0x02]), Buffer.alloc(9 * 1024 * 1024, 0x61)]);
    const form = new FormData();
    form.append('kind', 'audio');
    form.append('file', new Blob([audio], { type: 'audio/ogg' }), 'long.ogg');
    const up = await app.request(`/api/meetings/${meetingId}/media`, { method: 'POST', headers: { authorization: `Bearer ${await token('recorder')}`, 'x-crove-org': slug }, body: form });
    expect(up.status).toBe(200);

    const play = await app.request(`/api/meetings/${meetingId}/audio`, { headers: { authorization: `Bearer ${await token('recorder')}`, 'x-crove-org': slug } });
    expect(play.status).toBe(200);
    expect(play.headers.get('content-length')).toBe(String(audio.length));

    // The response is open and nothing past the first window has been read: delete the meeting now.
    const deleted = await rpc('meetings/delete', 'recorder', { meetingId });
    expect(deleted.status).toBe(200);

    const reader = play.body!.getReader();
    let received = 0;
    let failed = false;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.length;
      }
    } catch {
      failed = true;
    }
    // The stream errors before the whole audio is out; it never completes after the delete.
    expect(failed).toBe(true);
    expect(received).toBeLessThan(audio.length);
  });

  it('12b. full-file playback reads and decrypts one window at a time, never the whole file (#2874)', async () => {
    const createRes = await rpc('meetings/create', 'recorder', { title: 'Bounded Playback', visibility: 'attendees', consentMethod: 'told_at_start' });
    const meetingId = String(createRes.body.meetingId);
    // 13 MiB: four 4 MiB windows, so a whole-file read would show as one ranged read of the file's size.
    const audio = Buffer.concat([Buffer.from([0x4f, 0x67, 0x67, 0x53, 0x00, 0x02]), Buffer.alloc(13 * 1024 * 1024, 0x62)]);
    const form = new FormData();
    form.append('kind', 'audio');
    form.append('file', new Blob([audio], { type: 'audio/ogg' }), 'bounded.ogg');
    const up = await app.request(`/api/meetings/${meetingId}/media`, { method: 'POST', headers: { authorization: `Bearer ${await token('recorder')}`, 'x-crove-org': slug }, body: form });
    expect(up.status).toBe(200);

    const before = store.ranges.length;
    const play = await app.request(`/api/meetings/${meetingId}/audio`, { headers: { authorization: `Bearer ${await token('recorder')}`, 'x-crove-org': slug } });
    expect(play.status).toBe(200);
    const reader = play.body!.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(first.value!.length).toBeLessThanOrEqual(4 * 1024 * 1024);
    // One window out and at most one read ahead (the stream's queue of one): the other windows are not read until the client asks.
    expect(store.ranges.length - before).toBeLessThanOrEqual(2);

    let received = first.value!.length;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      expect(value.length).toBeLessThanOrEqual(4 * 1024 * 1024);
      received += value.length;
    }
    expect(received).toBe(audio.length);
    const reads = store.ranges.slice(before);
    expect(reads.length).toBeGreaterThanOrEqual(4);
    // A window is 4 MiB of plaintext plus the cipher's per-chunk overhead, never the sealed file (13 MiB and more).
    for (const r of reads) expect(r.length).toBeLessThan(5 * 1024 * 1024);
  });

  it('13. an audio upload over the audio cap is refused before its body is read', async () => {
    const createRes = await rpc('meetings/create', 'recorder', { title: 'Audio Cap', visibility: 'attendees', keepVideo: true, consentMethod: 'told_at_start' });
    const meetingId = String(createRes.body.meetingId);
    let pulled = false;
    // highWaterMark 0: pull runs only when something reads, so `pulled` shows whether the body was consumed.
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulled = true;
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    // Declares a 400 MB body for audio (cap 300 MB): the gate answers from the header, so the stream is never consumed.
    const res = await app.request(`/api/meetings/${meetingId}/media?kind=audio`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await token('recorder')}`,
        'x-crove-org': slug,
        'content-type': 'multipart/form-data; boundary=x',
        'content-length': String(400 * 1024 * 1024),
      },
      body,
      duplex: 'half',
    } as RequestInit);
    expect(res.status).toBe(413);
    expect(pulled).toBe(false);
  });

  it('14. a second concurrent video transfer gets 503 busy, and an audio one is not held back', async () => {
    const createRes = await rpc('meetings/create', 'recorder', { title: 'Video Slot', visibility: 'attendees', keepVideo: true, consentMethod: 'told_at_start' });
    const meetingId = String(createRes.body.meetingId);
    const videoUploads = new ConcurrencyLimiter({ total: 1, perKey: 1 });
    const busyApp = createHttpApp({ ...deps, videoUploads });
    const held = videoUploads.tryAcquire('another-transfer');
    expect(held).not.toBeNull();

    const send = async (kind: 'audio' | 'video', bytes: Buffer, type: string) => {
      const form = new FormData();
      form.append('kind', kind);
      form.append('file', new Blob([new Uint8Array(bytes)], { type }), `m.${kind === 'video' ? 'mp4' : 'ogg'}`);
      return busyApp.request(`/api/meetings/${meetingId}/media?kind=${kind}`, { method: 'POST', headers: { authorization: `Bearer ${await token('recorder')}`, 'x-crove-org': slug }, body: form });
    };
    const mp4 = Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70]), Buffer.from('isom-video-bytes'.repeat(10))]);
    const ogg = Buffer.concat([Buffer.from([0x4f, 0x67, 0x67, 0x53, 0x00, 0x02]), Buffer.from('slot-audio-bytes'.repeat(10))]);

    const refused = await send('video', mp4, 'video/mp4');
    expect(refused.status).toBe(503);
    expect(refused.headers.get('retry-after')).not.toBeNull();
    expect(videoUploads.inUse).toBe(1);

    const audioRes = await send('audio', ogg, 'audio/ogg');
    expect(audioRes.status).toBe(200);

    held!();
    const accepted = await send('video', mp4, 'video/mp4');
    expect(accepted.status).toBe(200);
    await vi.waitFor(() => expect(videoUploads.inUse).toBe(0));
  });
  it('15. a raw-body upload (STORAGE=local) is sealed as it arrives, plays back, and its refusals leave no object (#2780)', async () => {
    const createRes = await rpc('meetings/create', 'recorder', { title: 'Raw body upload', visibility: 'attendees', keepVideo: false, consentMethod: 'told_at_start' });
    const meetingId = String(createRes.body.meetingId);
    const ogg = Buffer.concat([Buffer.from([0x4f, 0x67, 0x67, 0x53, 0x00, 0x02]), Buffer.from('raw body upload '.repeat(40))]);
    const send = async (query: string, body: Buffer | null, type: string, who = 'recorder') =>
      app.request(`/api/meetings/${meetingId}/media${query}`, {
        method: 'POST',
        // A client sends the length of the file it uploads; a bare Request does not add the header, so the test says it.
        headers: { authorization: `Bearer ${await token(who)}`, 'x-crove-org': slug, 'content-type': type, 'content-length': String(body?.length ?? 0) },
        ...(body ? { body: new Uint8Array(body) } : {}),
      });
    const objectsBefore = store.storage.size;

    // The kind is required, a body that is not a media container and an empty one are refused, none stores anything.
    expect((await send('', ogg, 'audio/ogg')).status).toBe(400);
    expect((await send('?kind=sideways', ogg, 'audio/ogg')).status).toBe(400);
    expect((await send('?kind=audio', Buffer.from('not media, just text '.repeat(10)), 'audio/ogg')).status).toBe(400);
    expect((await send('?kind=audio', null, 'audio/ogg')).status).toBe(400);
    expect((await send('?kind=audio&lengthSeconds=0', ogg, 'audio/ogg')).status).toBe(400);
    // A member who is not a reader of this attendees-only meeting does not even see it: the gate answers as for a meeting that does not exist.
    expect((await send('?kind=audio', ogg, 'audio/ogg', 'attendee')).status).toBe(404);
    expect(store.storage.size).toBe(objectsBefore);

    // A raw body must declare its length: a chunked one is refused before one byte of it is read (the cap is then enforced on a
    // declared size, and the sealing counts the bytes as they arrive).
    let pulled = false;
    const chunked = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulled = true;
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const noLength = await app.request(`/api/meetings/${meetingId}/media?kind=audio`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await token('recorder')}`, 'x-crove-org': slug, 'content-type': 'audio/ogg', 'transfer-encoding': 'chunked' },
      body: chunked,
      duplex: 'half',
    } as RequestInit);
    expect(noLength.status).toBe(400);
    expect(pulled).toBe(false);
    // A declared length over the audio cap is refused from the header alone.
    const huge = await app.request(`/api/meetings/${meetingId}/media?kind=audio`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await token('recorder')}`, 'x-crove-org': slug, 'content-type': 'audio/ogg', 'content-length': String(400 * 1024 * 1024) },
      body: new ReadableStream<Uint8Array>({ pull: () => void (pulled = true) }, { highWaterMark: 0 }),
      duplex: 'half',
    } as RequestInit);
    expect(huge.status).toBe(413);
    expect(pulled).toBe(false);

    // A body that ends short of the length it declared (an aborted upload) is refused and stores nothing: a stream that stops
    // still ends in a "last" chunk, so the declared length is what tells a cut file from a whole one (Platform PO N1).
    const cut = await app.request(`/api/meetings/${meetingId}/media?kind=audio`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await token('recorder')}`, 'x-crove-org': slug, 'content-type': 'audio/ogg', 'content-length': String(ogg.length + 500) },
      body: new Uint8Array(ogg),
    });
    expect(cut.status).toBe(400);
    expect(store.storage.size).toBe(objectsBefore);

    const ok = await send('?kind=audio&lengthSeconds=12', ogg, 'audio/ogg');
    expect(ok.status).toBe(200);
    expect(store.storage.size).toBe(objectsBefore + 1);
    // Ciphertext at rest: the plaintext is nowhere in the stored bytes, and the object is under its own sha256.
    const [key, stored] = [...store.storage.entries()].at(-1)!;
    expect(Buffer.from(stored.bytes).includes(Buffer.from('raw body upload'))).toBe(false);
    expect(key.endsWith(`/${sha256Hex(stored.bytes)}`)).toBe(true);

    const played = await app.request(`/api/meetings/${meetingId}/audio`, { headers: { authorization: `Bearer ${await token('recorder')}`, 'x-crove-org': slug } });
    expect(played.status).toBe(200);
    expect(Buffer.from(await played.arrayBuffer()).equals(ogg)).toBe(true);

    // A second upload of the same kind is refused after it was sealed: the sealed object is dropped again.
    const again = await send('?kind=audio', ogg, 'audio/ogg');
    expect(again.status).toBeGreaterThanOrEqual(400);
    expect(store.storage.size).toBe(objectsBefore + 1);
  });

  it('16. a staged upload is read as a stream, and one over its grant is refused and its staged object dropped (#2780)', async () => {
    const createRes = await rpc('meetings/create', 'recorder', { title: 'Streamed staged', visibility: 'attendees', keepVideo: true, consentMethod: 'told_at_start' });
    const meetingId = String(createRes.body.meetingId);
    const grant = async (bytes: Buffer, maxBytes: number) => {
      const uploadId = randomUUID();
      const stagingKey = `staging/${randomBytes(32).toString('hex')}`;
      store.staged.set(stagingKey, bytes);
      await admin(async (c) => {
        await c.query(
          `INSERT INTO crove_kernel.file_upload (org_id, id, staging_key, created_by, max_bytes, purpose, created_at, expires_at)
           VALUES ($1, $2, $3, $4, $5, 'meeting_video', now(), now() + interval '5 minutes')`,
          [orgId, uploadId, stagingKey, userIds.get('recorder'), maxBytes],
        );
      });
      return { uploadId, stagingKey };
    };
    const mp4 = Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x18]), Buffer.from('ftypmp42'), Buffer.alloc(500, 3)]);

    const tooBig = await grant(mp4, 100);
    const refused = await claimStagedMedia('recorder', meetingId, 'video', tooBig.uploadId);
    expect(refused.status).toBe(413);
    expect(store.staged.has(tooBig.stagingKey)).toBe(false);

    const fine = await grant(mp4, 10_000);
    const opened = store.opened.length;
    const accepted = await claimStagedMedia('recorder', meetingId, 'video', fine.uploadId);
    expect(accepted.status).toBe(200);
    expect(store.opened.length).toBe(opened + 1);
    expect(store.staged.has(fine.stagingKey)).toBe(false);
    const played = await app.request(`/api/meetings/${meetingId}/video`, { headers: { authorization: `Bearer ${await token('recorder')}`, 'x-crove-org': slug } });
    expect(Buffer.from(await played.arrayBuffer()).equals(mp4)).toBe(true);
  });
  it('17. a malformed Content-Length on a raw body is refused with 400, not left to fail later (#2780)', async () => {
    const createRes = await rpc('meetings/create', 'recorder', { title: 'Bad length', visibility: 'attendees', keepVideo: false, consentMethod: 'told_at_start' });
    const meetingId = String(createRes.body.meetingId);
    const before = store.storage.size;
    for (const length of ['abc', '-5', '1e3', '12 34', '']) {
      const res = await app.request(`/api/meetings/${meetingId}/media?kind=audio`, {
        method: 'POST',
        headers: { authorization: `Bearer ${await token('recorder')}`, 'x-crove-org': slug, 'content-type': 'audio/ogg', 'content-length': length },
        body: new Uint8Array(Buffer.from('OggS-not-reached')),
      });
      expect(res.status, `content-length "${length}"`).toBe(400);
    }
    expect(store.storage.size).toBe(before);
  });

  it('18. a raw video upload that stops sending is cancelled, stores nothing and frees the video slot (#2780)', async () => {
    const createRes = await rpc('meetings/create', 'recorder', { title: 'Stalled upload', visibility: 'attendees', keepVideo: true, consentMethod: 'told_at_start' });
    const meetingId = String(createRes.body.meetingId);
    const videoUploads = new ConcurrencyLimiter({ total: 1, perKey: 1 });
    const stallingApp = createHttpApp({ ...deps, videoUploads, mediaStallMs: 150 });
    const mp4 = Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x18]), Buffer.from('ftypmp42'), Buffer.alloc(500, 3)]);
    let cancelled = false;
    let sent = false;
    // The first piece arrives, then nothing: the connection is open but silent.
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (!sent) {
            sent = true;
            controller.enqueue(new Uint8Array(mp4));
          }
          return new Promise(() => undefined);
        },
        cancel: () => {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const before = store.storage.size;
    const res = await stallingApp.request(`/api/meetings/${meetingId}/media?kind=video`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await token('recorder')}`, 'x-crove-org': slug, 'content-type': 'video/mp4', 'content-length': String(mp4.length + 5000) },
      body,
      duplex: 'half',
    } as RequestInit);
    expect(res.status).toBe(400);
    expect(cancelled).toBe(true);
    expect(store.storage.size).toBe(before);
    await vi.waitFor(() => expect(videoUploads.inUse).toBe(0));
    // The slot is free again: a whole upload of the same meeting now goes through.
    const again = await stallingApp.request(`/api/meetings/${meetingId}/media?kind=video`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await token('recorder')}`, 'x-crove-org': slug, 'content-type': 'video/mp4', 'content-length': String(mp4.length) },
      body: new Uint8Array(mp4),
    });
    expect(again.status).toBe(200);
  });

  it('19. a missing media key refuses a staged upload before its object is opened (#2780)', async () => {
    const createRes = await rpc('meetings/create', 'recorder', { title: 'No key', visibility: 'attendees', keepVideo: false, consentMethod: 'told_at_start' });
    const meetingId = String(createRes.body.meetingId);
    const uploadId = randomUUID();
    const stagingKey = `staging/${randomBytes(32).toString('hex')}`;
    store.staged.set(stagingKey, Buffer.concat([Buffer.from([0x4f, 0x67, 0x67, 0x53, 0x00, 0x02]), Buffer.alloc(100, 5)]));
    await admin(async (c) => {
      await c.query(
        `INSERT INTO crove_kernel.file_upload (org_id, id, staging_key, created_by, max_bytes, purpose, created_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, 'meeting_audio', now(), now() + interval '5 minutes')`,
        [orgId, uploadId, stagingKey, userIds.get('recorder'), 300 * 1024 * 1024],
      );
    });
    const keyless = createHttpApp({ ...deps, broker: { ...broker, keyId: undefined } as unknown as CredentialBroker });
    const opened = store.opened.length;
    const res = await keyless.request(`/api/meetings/${meetingId}/media`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await token('recorder')}`, 'content-type': 'application/json', 'x-crove-org': slug },
      body: JSON.stringify({ uploadId, kind: 'audio' }),
    });
    expect(res.status).toBe(503);
    // The key is checked first: no staged read was opened, so none is left open, and the staged object is dropped with the claim.
    expect(store.opened.length).toBe(opened);
    expect(store.staged.has(stagingKey)).toBe(false);
  });

  it('20. the media route seals with the injected broker, the one the server shares with the reseal pass (#2703)', async () => {
    // The config of this file has no credential key, so the route's own fallback (createCredentialBroker(config)) could seal nothing:
    // a sealed claim, and the injected broker's key derivations, show the route used deps.broker.
    const purposes: string[] = [];
    const counting = {
      ...broker,
      deriveKey: (keyId: string, purpose: string) => {
        purposes.push(`${keyId}:${purpose}`);
        return broker.deriveKey!(keyId, purpose);
      },
    } as unknown as CredentialBroker;
    const shared = createHttpApp({ ...deps, broker: counting });
    const createRes = await rpc('meetings/create', 'recorder', { title: 'Shared broker', visibility: 'attendees', keepVideo: false, consentMethod: 'told_at_start' });
    const meetingId = String(createRes.body.meetingId);
    const uploadId = randomUUID();
    const stagingKey = `staging/${randomBytes(32).toString('hex')}`;
    store.staged.set(stagingKey, Buffer.concat([Buffer.from([0x4f, 0x67, 0x67, 0x53, 0x00, 0x02]), Buffer.alloc(100, 7)]));
    await admin(async (c) => {
      await c.query(
        `INSERT INTO crove_kernel.file_upload (org_id, id, staging_key, created_by, max_bytes, purpose, created_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, 'meeting_audio', now(), now() + interval '5 minutes')`,
        [orgId, uploadId, stagingKey, userIds.get('recorder'), 300 * 1024 * 1024],
      );
    });
    const res = await shared.request(`/api/meetings/${meetingId}/media`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await token('recorder')}`, 'content-type': 'application/json', 'x-crove-org': slug },
      body: JSON.stringify({ uploadId, kind: 'audio' }),
    });
    expect(res.status).toBe(200);
    expect(purposes).toContain('k1-meetings-test:crove.meetings.v1|wrap');
    const keyId = await admin(async (c) => (await c.query<{ key_id: string }>('SELECT key_id FROM crove_meetings.media_key WHERE meeting_id = $1', [meetingId])).rows[0]?.key_id);
    expect(keyId).toBe('k1-meetings-test');
  });

  // Meetings A1 (#3159): the recording notice, the new consent method, the stop reason and the recording indicator's query.
  const OGG = Buffer.concat([Buffer.from([0x4f, 0x67, 0x67, 0x53, 0x00, 0x02]), Buffer.from('a1 notice upload '.repeat(40))]);
  const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from('a1 video upload '.repeat(40))]);
  const uploadRaw = async (meetingId: string, query: string, who = 'recorder') =>
    app.request(`/api/meetings/${meetingId}/media${query}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await token(who)}`, 'x-crove-org': slug, 'content-type': 'audio/ogg', 'content-length': String(OGG.length) },
      body: new Uint8Array(OGG),
    });

  it('21. A1: pasting the notice in the call chat is a consent method; the version shown is stored, an unknown one is refused, the audit holds codes only', async () => {
    const made = await rpc('meetings/create', 'recorder', { title: 'Notice pasted', consentMethod: 'in_call_chat', consentNoticeVersion: '2026-11-v1' });
    expect(made.status).toBe(200);
    const row = await admin(async (c) => (await c.query<{ consent_method: string; consent_notice_version: string }>('SELECT consent_method, consent_notice_version FROM crove_meetings.meeting WHERE id = $1', [String(made.body.meetingId)])).rows[0]);
    expect(row).toEqual({ consent_method: 'in_call_chat', consent_notice_version: '2026-11-v1' });
    // The version is the current one when the client says none.
    const plain = await rpc('meetings/create', 'recorder', { title: 'No version', consentMethod: 'told_at_start' });
    const plainRow = await admin(async (c) => (await c.query<{ consent_notice_version: string }>('SELECT consent_notice_version FROM crove_meetings.meeting WHERE id = $1', [String(plain.body.meetingId)])).rows[0]);
    expect(plainRow?.consent_notice_version).toBe('2026-11-v1');
    // A version the server does not know, and a method it does not know, are refused and create nothing.
    const before = await admin(async (c) => Number((await c.query<{ n: string }>('SELECT count(*) AS n FROM crove_meetings.meeting')).rows[0]?.n));
    expect((await rpc('meetings/create', 'recorder', { title: 'Bad version', consentMethod: 'in_call_chat', consentNoticeVersion: '1999-01-v9' })).status).toBe(400);
    expect((await rpc('meetings/create', 'recorder', { title: 'Bad method', consentMethod: 'in_the_hallway' })).status).toBe(400);
    expect(await admin(async (c) => Number((await c.query<{ n: string }>('SELECT count(*) AS n FROM crove_meetings.meeting')).rows[0]?.n))).toBe(before);
    // The audit row names the method and the version, and holds none of the notice's words or the title.
    const audit = await admin(async (c) => (await c.query<{ detail: Record<string, unknown> }>(`SELECT detail FROM crove_kernel.audit_event WHERE command = 'meetings.meeting.create' AND detail->>'meetingId' = $1`, [String(made.body.meetingId)])).rows[0]?.detail);
    expect(audit).toMatchObject({ consentMethod: 'in_call_chat', consentNoticeVersion: '2026-11-v1' });
    expect(JSON.stringify(audit)).not.toMatch(/ghi âm|recorded|Notice pasted/);
    // The meeting says so when read back, and audio is still refused for a meeting whose consent was not recorded (the column is NOT NULL).
    const got = await rpc('meetings/get', 'recorder', { meetingId: String(made.body.meetingId) });
    expect(got.body).toMatchObject({ consentMethod: 'in_call_chat', consentNoticeVersion: '2026-11-v1', recordingStopReason: null });
  });

  it('22. A1: a recording that stopped by itself keeps its reason code and stop time on the meeting, once; an unknown code is refused', async () => {
    const made = await rpc('meetings/create', 'recorder', { title: 'Stopped by itself', consentMethod: 'in_call_chat' });
    const meetingId = String(made.body.meetingId);
    const objects = store.storage.size;
    expect((await uploadRaw(meetingId, '?kind=audio&stopReason=whatever')).status).toBe(400);
    expect(store.storage.size).toBe(objects);
    expect((await uploadRaw(meetingId, '?kind=audio&stopReason=tab_closed')).status).toBe(200);
    const got = await rpc('meetings/get', 'recorder', { meetingId });
    expect(got.body.recordingStopReason).toBe('tab_closed');
    expect(typeof got.body.endedAt).toBe('string');
    expect(new Date(String(got.body.endedAt)).getTime()).toBeGreaterThanOrEqual(new Date(String(got.body.startedAt)).getTime());
    expect(new Date(String(got.body.endedAt)).getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    const audit = await admin(async (c) => (await c.query<{ detail: Record<string, unknown> }>(`SELECT detail FROM crove_kernel.audit_event WHERE command = 'meetings.media.record' AND detail->>'meetingId' = $1`, [meetingId])).rows[0]?.detail);
    expect(audit).toMatchObject({ stopReason: 'tab_closed' });
    // A recording the recorder stopped has no reason and no stop time of its own.
    const clean = await rpc('meetings/create', 'recorder', { title: 'Stopped by a click', consentMethod: 'told_at_start' });
    expect((await uploadRaw(String(clean.body.meetingId), '?kind=audio')).status).toBe(200);
    const cleanGot = await rpc('meetings/get', 'recorder', { meetingId: String(clean.body.meetingId) });
    expect(cleanGot.body.recordingStopReason).toBeNull();
    // Its end time is set by the upload like any other, so the recording chip lets go of it.
    expect(typeof cleanGot.body.endedAt).toBe('string');
  });

  it('23. A1: recording_now shows the caller\'s own extension meeting that is still waiting for audio, and nothing once it has audio or stopped', async () => {
    const made = await rpc('meetings/create', 'recorder', { title: 'Recording now', consentMethod: 'in_call_chat' });
    const meetingId = String(made.body.meetingId);
    // Made in the app (no extension token): the app knows its own recording, the server does not claim it.
    expect((await rpc('meetings/recordingNow', 'recorder', {})).body.recording).toBeNull();
    // Made by an extension token (stamped as the extension scope does).
    await admin(async (c) => void (await c.query('UPDATE crove_meetings.meeting SET extension_token_id = $1 WHERE id = $2', [randomUUID(), meetingId])));
    const now = await rpc('meetings/recordingNow', 'recorder', {});
    expect(now.status).toBe(200);
    expect(now.body.recording).toEqual({ meetingId, startedAt: expect.any(String) });
    // Another member sees nothing of it.
    expect((await rpc('meetings/recordingNow', 'attendee', {})).body.recording).toBeNull();
    // Older than the window: not a recording any more.
    await admin(async (c) => void (await c.query(`UPDATE crove_meetings.meeting SET started_at = now() - interval '5 hours' WHERE id = $1`, [meetingId])));
    expect((await rpc('meetings/recordingNow', 'recorder', {})).body.recording).toBeNull();
    await admin(async (c) => void (await c.query(`UPDATE crove_meetings.meeting SET started_at = now() - interval '1 minute' WHERE id = $1`, [meetingId])));
    expect((await rpc('meetings/recordingNow', 'recorder', {})).body.recording).toMatchObject({ meetingId });
    // Once its audio arrives (and the stop is recorded) the chip has nothing to show.
    expect((await uploadRaw(meetingId, '?kind=audio&stopReason=mic_lost')).status).toBe(200);
    expect((await rpc('meetings/recordingNow', 'recorder', {})).body.recording).toBeNull();
    // A video recording (no audio segment of its own) ends the chip too.
    const withVideo = await rpc('meetings/create', 'recorder', { title: 'Recording video', consentMethod: 'told_at_start', keepVideo: true });
    const videoId = String(withVideo.body.meetingId);
    await admin(async (c) => void (await c.query('UPDATE crove_meetings.meeting SET extension_token_id = $1 WHERE id = $2', [randomUUID(), videoId])));
    expect((await rpc('meetings/recordingNow', 'recorder', {})).body.recording).toMatchObject({ meetingId: videoId });
    const video = await app.request(`/api/meetings/${videoId}/media?kind=video`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await token('recorder')}`, 'x-crove-org': slug, 'content-type': 'video/webm', 'content-length': String(WEBM.length) },
      body: new Uint8Array(WEBM),
    });
    expect(video.status).toBe(200);
    expect((await rpc('meetings/recordingNow', 'recorder', {})).body.recording).toBeNull();
  });

  // Meetings A2 (#3160): the org setting "consent required before recording".
  const createWith = (who: string, consentMethod: string, title: string) => rpc('meetings/create', who, { title, consentMethod });
  const meetingCount = async () => admin(async (c) => Number((await c.query<{ n: string }>('SELECT count(*) AS n FROM crove_meetings.meeting WHERE org_id = $1', [orgId])).rows[0]?.n));

  it('24. A2: the consent policy is standard by default, every member reads it, only an owner or admin changes it, and the audit holds codes only', async () => {
    expect((await rpc('meetings/consentPolicy/get', 'recorder', {})).body).toEqual({ policy: 'standard' });
    expect((await rpc('meetings/consentPolicy/get', 'viewer', {})).status).toBe(403);
    // A member and a viewer cannot change it.
    expect((await rpc('meetings/consentPolicy/set', 'recorder', { policy: 'strict' })).status).toBe(403);
    expect((await rpc('meetings/consentPolicy/set', 'viewer', { policy: 'strict' })).status).toBe(403);
    expect((await rpc('meetings/consentPolicy/get', 'owner', {})).body.policy).toBe('standard');
    // An unknown value is refused.
    expect((await rpc('meetings/consentPolicy/set', 'owner', { policy: 'lax' })).status).toBe(400);
    // The owner sets it, and sets it back.
    expect((await rpc('meetings/consentPolicy/set', 'owner', { policy: 'strict' })).body).toEqual({ policy: 'strict' });
    expect((await rpc('meetings/consentPolicy/get', 'recorder', {})).body.policy).toBe('strict');
    expect((await rpc('meetings/consentPolicy/set', 'owner', { policy: 'standard' })).status).toBe(200);
    const audits = await admin(async (c) => (await c.query<{ detail: Record<string, unknown> }>(`SELECT detail FROM crove_kernel.audit_event WHERE command = 'meetings.consent_policy.set' AND outcome = 'ok' ORDER BY occurred_at`)).rows.map((r) => r.detail));
    expect(audits).toEqual([expect.objectContaining({ policy: 'strict', previous: 'standard' }), expect.objectContaining({ policy: 'standard', previous: 'strict' })]);
    // Codes only: exactly these keys, nothing free-form beside them.
    for (const detail of audits) expect(Object.keys(detail).filter((k) => !['extensionToken', 'requestId'].includes(k)).sort()).toEqual(['policy', 'previous']);
    // An admin may change it too, and a member may not.
    await join('adminUser', 'admin');
    expect((await rpc('meetings/consentPolicy/set', 'adminUser', { policy: 'strict' })).body).toEqual({ policy: 'strict' });
    expect((await rpc('meetings/consentPolicy/set', 'recorder', { policy: 'standard' })).status).toBe(403);
    expect((await rpc('meetings/consentPolicy/set', 'adminUser', { policy: 'standard' })).status).toBe(200);
  });

  it('25. A2: a strict org refuses a meeting whose consent method is not written, creates nothing, and a change applies only to meetings created afterwards', async () => {
    // Made under standard: stays valid when the org turns strict.
    const early = await createWith('recorder', 'told_at_start', 'Created before strict');
    expect(early.status).toBe(200);
    expect((await rpc('meetings/consentPolicy/set', 'owner', { policy: 'strict' })).status).toBe(200);
    try {
      const before = await meetingCount();
      const refused = await createWith('recorder', 'told_at_start', 'Said at the start');
      expect(refused.status).toBe(422);
      expect(refused.body.code).toBe('CONSENT_METHOD_NOT_ALLOWED');
      expect(await meetingCount()).toBe(before);
      // The written methods are accepted.
      for (const method of ['in_invite', 'in_writing', 'in_call_chat']) expect((await createWith('recorder', method, `Written ${method}`)).status).toBe(200);
      // The recorder screen, the extension and the upload form all create their meeting through this one command, so the owner meets the same rule.
      expect((await createWith('owner', 'told_at_start', 'Owner said it')).status).toBe(422);
      // The meeting made before the change still takes its audio.
      expect((await uploadRaw(String(early.body.meetingId), '?kind=audio')).status).toBe(200);
    } finally {
      expect((await rpc('meetings/consentPolicy/set', 'owner', { policy: 'standard' })).status).toBe(200);
    }
    // Back to standard: every method again.
    expect((await createWith('recorder', 'told_at_start', 'Said at the start again')).status).toBe(200);
  });

  // Meetings C1 (#3173): a recording a meeting platform finished is imported through meetings.import.start, a worker's staged bytes and the media route's importId.
  const IMPORT_NOTICE_VERSION = '2026-11-imp-v1';
  const asUser = (name: string) => ({ type: 'user' as const, userId: userIds.get(name)!, aal: 'aal1' as const, sessionId: accounts.get(name)!.session });
  const startImport = (who: string, input: Record<string, unknown>) =>
    runtime.execute<{ meetingId: string }>('meetings.import.start', { consentMethod: 'platform_notice', consentNoticeVersion: IMPORT_NOTICE_VERSION, consentConfirmed: true, ...input }, { actor: asUser(who), orgId });
  const refusedWith = (promise: Promise<unknown>) => promise.then(() => null, (error: unknown) => (error as { code?: string }).code ?? 'ERR');
  const meetingExists = (id: string) => admin(async (c) => (await c.query('SELECT 1 FROM crove_meetings.meeting WHERE id = $1', [id])).rowCount === 1);
  // A suggested recording of a member's own connection, as the sweep leaves it (the table owner writes it: the sweep's definer needs the worker login).
  async function suggest(who: string, over: { title?: string; startedAt?: string; sizeBytes?: number | null; hasAudio?: boolean; hasVideo?: boolean; hasTranscript?: boolean; provider?: string } = {}) {
    const recordingId = randomUUID();
    await admin(async (c) => {
      const connection = await c.query<{ id: string }>(
        `INSERT INTO crove_kernel.meeting_platform_connection (org_id, user_id, provider, external_account, display_name) VALUES ($1, $2, $4, $3, 'Sandbox') RETURNING id`,
        [orgId, userIds.get(who), `${who}-${randomUUID()}@sandbox.test`, over.provider ?? 'sandbox'],
      );
      await c.query(
        `INSERT INTO crove_kernel.meeting_platform_recording (org_id, id, connection_id, user_id, external_id, title, started_at, size_bytes, has_audio, has_video, has_transcript)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [orgId, recordingId, connection.rows[0]!.id, userIds.get(who), randomUUID(), over.title ?? 'Họp khách hàng', over.startedAt ?? new Date(Date.now() - 90 * 86_400_000).toISOString(), over.sizeBytes === undefined ? 4096 : over.sizeBytes, over.hasAudio ?? true, over.hasVideo ?? false, over.hasTranscript ?? false],
      );
    });
    return recordingId;
  }
  const recordingRowCount = (connectionId: string) => admin(async (c) => Number((await c.query<{ n: string }>('SELECT count(*) AS n FROM crove_kernel.meeting_platform_recording WHERE connection_id = $1', [connectionId])).rows[0]?.n));
  const recordingRow = (id: string) =>
    admin(async (c) => (await c.query<{ status: string; meeting_id: string | null; staging_key: string | null; error_code: string | null }>('SELECT status, meeting_id, staging_key, error_code FROM crove_kernel.meeting_platform_recording WHERE id = $1', [id])).rows[0]!);
  // What the worker does: the bytes wait under the row's staging key and the row becomes staged.
  async function stage(recordingId: string, bytes: Buffer = OGG) {
    const row = await recordingRow(recordingId);
    store.staged.set(row.staging_key!, bytes);
    await admin((c) => c.query(`UPDATE crove_kernel.meeting_platform_recording SET status = 'staged', staged_at = now() WHERE id = $1`, [recordingId]));
    return row.staging_key!;
  }
  const claimImport = async (who: string, meetingId: string, body: Record<string, unknown>) => {
    const response = await app.request(`/api/meetings/${meetingId}/media`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await token(who)}`, 'content-type': 'application/json', 'x-crove-org': slug },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };

  it('26. C1: importing makes the meeting with the platform-notice consent, counts the periods from today, links the row and audits ids only', async () => {
    const recordingId = await suggest('recorder', { title: 'Họp khách hàng cũ' });
    const { meetingId } = await startImport('recorder', { recordingId, language: 'vi', visibility: 'attendees', readerUserIds: [userIds.get('attendee')!] });
    const meeting = await admin(async (c) =>
      (await c.query<{ title: string; consent_method: string; consent_notice_version: string; keep_video: boolean; live_notes: boolean; ended_at: Date | null; started_old: boolean; audio_future: boolean; readers: string }>(
        `SELECT title, consent_method, consent_notice_version, keep_video, live_notes, ended_at, started_at < now() - interval '60 days' AS started_old,
                audio_retention_date > (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date AS audio_future,
                (SELECT count(*) FROM crove_meetings.meeting_reader r WHERE r.meeting_id = m.id)::text AS readers
         FROM crove_meetings.meeting m WHERE id = $1`,
        [meetingId],
      )).rows[0],
    );
    expect(meeting).toEqual({ title: 'Họp khách hàng cũ', consent_method: 'platform_notice', consent_notice_version: IMPORT_NOTICE_VERSION, keep_video: false, live_notes: false, ended_at: null, started_old: true, audio_future: true, readers: '1' });
    const row = await recordingRow(recordingId);
    expect(row).toMatchObject({ status: 'importing', meeting_id: meetingId, error_code: null });
    expect(row.staging_key).toMatch(/^staging\/[0-9a-f]{64}$/);
    // The audit row names the ids and the provider, never the title, the staging key or the platform's id.
    const detail = await admin(async (c) => (await c.query<{ detail: Record<string, unknown> }>(`SELECT detail FROM crove_kernel.audit_event WHERE command = 'meetings.import.start' AND detail->>'meetingId' = $1`, [meetingId])).rows[0]?.detail);
    expect(detail).toMatchObject({ recordingId, meetingId, provider: 'sandbox', consentMethod: 'platform_notice' });
    expect(JSON.stringify(detail)).not.toContain('Họp khách hàng');
    expect(JSON.stringify(detail)).not.toContain('staging/');
  });

  it('27. C1: a title may be chosen, an untitled recording gets a plain name, and the import refuses another member\'s row, a second click, a wrong notice and an unconfirmed consent', async () => {
    const chosen = await suggest('recorder');
    const { meetingId } = await startImport('recorder', { recordingId: chosen, title: 'Tên do tôi đặt' });
    expect((await admin(async (c) => (await c.query<{ title: string }>('SELECT title FROM crove_meetings.meeting WHERE id = $1', [meetingId])).rows[0]))?.title).toBe('Tên do tôi đặt');
    const untitled = await suggest('recorder', { title: '' });
    const made = await startImport('recorder', { recordingId: untitled, language: 'en' });
    expect((await admin(async (c) => (await c.query<{ title: string }>('SELECT title FROM crove_meetings.meeting WHERE id = $1', [made.meetingId])).rows[0]))?.title).toBe('Imported meeting');

    const before = await meetingCount();
    const mine = await suggest('recorder');
    // Another member's row is answered as absent, and nothing is made.
    expect(await refusedWith(startImport('otherMember', { recordingId: mine }))).toBe('MEETING_PLATFORM_NOT_FOUND');
    // A second click on a row that is already importing.
    expect(await refusedWith(startImport('recorder', { recordingId: chosen }))).toBe('MEETING_PLATFORM_STATE');
    // The only notice and consent this command accepts.
    expect(await refusedWith(startImport('recorder', { recordingId: mine, consentNoticeVersion: '2026-11-v1' }))).not.toBeNull();
    expect(await refusedWith(startImport('recorder', { recordingId: mine, consentConfirmed: false }))).not.toBeNull();
    expect(await refusedWith(startImport('recorder', { recordingId: mine, consentMethod: 'told_at_start' }))).not.toBeNull();
    expect(await meetingCount()).toBe(before);
    expect((await recordingRow(mine)).status).toBe('suggested');
    // A viewer cannot import.
    expect(await refusedWith(startImport('viewer', { recordingId: mine }))).not.toBeNull();
    // The method belongs to the import: a recording or an upload cannot claim it.
    expect((await createWith('recorder', 'platform_notice', 'Pretend import')).status).toBe(400);
  });

  it('28. C1: a strict org refuses the platform notice as it refuses any unwritten method, and the row stays a suggestion', async () => {
    const recordingId = await suggest('recorder');
    expect((await rpc('meetings/consentPolicy/set', 'owner', { policy: 'strict' })).status).toBe(200);
    try {
      const before = await meetingCount();
      expect(await refusedWith(startImport('recorder', { recordingId }))).toBe('CONSENT_METHOD_NOT_ALLOWED');
      expect(await meetingCount()).toBe(before);
      expect((await recordingRow(recordingId)).status).toBe('suggested');
    } finally {
      expect((await rpc('meetings/consentPolicy/set', 'owner', { policy: 'standard' })).status).toBe(200);
    }
    expect(await startImport('recorder', { recordingId })).toHaveProperty('meetingId');
  });

  it('29. C1: the staged bytes are claimed by importId, sealed and recorded like an upload; the row becomes imported and the meeting is ended', async () => {
    const recordingId = await suggest('recorder');
    const { meetingId } = await startImport('recorder', { recordingId });
    const key = await stage(recordingId);
    const done = await claimImport('recorder', meetingId, { importId: recordingId, kind: 'audio' });
    expect(done.status).toBe(200);
    expect(await recordingRow(recordingId)).toMatchObject({ status: 'imported', staging_key: null, error_code: null, meeting_id: meetingId });
    expect(store.staged.has(key)).toBe(false);
    const rows = await admin(async (c) => ({
      segments: Number((await c.query<{ n: string }>('SELECT count(*) AS n FROM crove_meetings.audio_segment WHERE meeting_id = $1', [meetingId])).rows[0]?.n),
      ended: (await c.query<{ e: boolean }>('SELECT ended_at IS NOT NULL AS e FROM crove_meetings.meeting WHERE id = $1', [meetingId])).rows[0]?.e,
      sealed: Number((await c.query<{ n: string }>('SELECT count(*) AS n FROM crove_meetings.media_key WHERE meeting_id = $1', [meetingId])).rows[0]?.n),
    }));
    expect(rows).toEqual({ segments: 1, ended: true, sealed: 1 });
    // The bytes are claimed once: the same row cannot be claimed again.
    expect((await claimImport('recorder', meetingId, { importId: recordingId, kind: 'audio' })).status).toBeGreaterThanOrEqual(400);
  });

  it('30. C1: an importId of another member\'s row is 404 and leaves it staged; both ids, a video kind and a bad id are 400; a row not yet staged cannot be claimed', async () => {
    const recordingId = await suggest('recorder');
    const { meetingId } = await startImport('recorder', { recordingId });
    // Not staged yet: the claim is refused and nothing changes.
    expect((await claimImport('recorder', meetingId, { importId: recordingId, kind: 'audio' })).status).toBe(409);
    await stage(recordingId);
    // Another member records their own meeting and names the recorder's row.
    const theirs = String((await rpc('meetings/create', 'otherMember', { title: 'Của tôi', consentMethod: 'told_at_start' })).body.meetingId);
    expect((await claimImport('otherMember', theirs, { importId: recordingId, kind: 'audio' })).status).toBe(404);
    expect((await recordingRow(recordingId)).status).toBe('staged');
    // The route's own checks.
    expect((await claimImport('recorder', meetingId, { importId: recordingId, uploadId: randomUUID(), kind: 'audio' })).status).toBe(400);
    expect((await claimImport('recorder', meetingId, { kind: 'audio' })).status).toBe(400);
    expect((await claimImport('recorder', meetingId, { importId: recordingId, kind: 'video' })).status).toBe(400);
    expect((await claimImport('recorder', meetingId, { importId: 'not-a-uuid', kind: 'audio' })).status).toBe(400);
    expect((await recordingRow(recordingId)).status).toBe('staged');
  });

  it('31. C1: a staged file that is no media fails the row with a short code and drops the bytes, and a request for another meeting is refused before the row moves', async () => {
    const hostile = await suggest('recorder');
    const { meetingId } = await startImport('recorder', { recordingId: hostile });
    const hostileKey = await stage(hostile, Buffer.from('this is not audio at all, only text '.repeat(10)));
    const refused = await claimImport('recorder', meetingId, { importId: hostile, kind: 'audio' });
    expect(refused.status).toBe(400);
    expect(await recordingRow(hostile)).toMatchObject({ status: 'failed', staging_key: null, error_code: 'invalid_media' });
    expect(store.staged.has(hostileKey)).toBe(false);
    // A failed row can be imported again, into a new meeting; the empty meeting the failed try made is removed, not left in the list (#3288).
    const before = await meetingCount();
    const again = await startImport('recorder', { recordingId: hostile });
    expect(again.meetingId).not.toBe(meetingId);
    expect(await recordingRow(hostile)).toMatchObject({ status: 'importing', meeting_id: again.meetingId });
    expect(await meetingExists(meetingId)).toBe(false);
    expect(await meetingCount(), 'the retry replaced the empty meeting, it did not add one').toBe(before);

    // The row is linked to one meeting; claiming it on the recorder's other meeting is refused as not found BEFORE the row moves: it stays staged, with its bytes, for the right meeting.
    const linked = await suggest('recorder');
    const linkedMeeting = await startImport('recorder', { recordingId: linked });
    const key = await stage(linked);
    const other = String((await rpc('meetings/create', 'recorder', { title: 'Một cuộc họp khác', consentMethod: 'told_at_start' })).body.meetingId);
    expect((await claimImport('recorder', other, { importId: linked, kind: 'audio' })).status).toBe(404);
    expect(await recordingRow(linked)).toMatchObject({ status: 'staged', staging_key: key, meeting_id: linkedMeeting.meetingId });
    expect(store.staged.has(key)).toBe(true);
  });

  it('31b. C1: a retry removes only the empty meeting of the failed try: one that holds a note, or another member\'s, or a recording that never failed, is kept (#3288)', async () => {
    const fail = (id: string) => admin((c) => c.query(`UPDATE crove_kernel.meeting_platform_recording SET status = 'failed', staging_key = NULL, error_code = 'timeout' WHERE id = $1`, [id]));
    // A failed try whose meeting holds a note the recorder typed: kept, and the retry makes a new meeting.
    const withNote = await suggest('recorder');
    const first = await startImport('recorder', { recordingId: withNote });
    await admin((c) => c.query(`INSERT INTO crove_meetings.meeting_note (org_id, meeting_id, body) VALUES ($1, $2, 'Ghi chú của tôi')`, [orgId, first.meetingId]));
    await fail(withNote);
    const second = await startImport('recorder', { recordingId: withNote });
    expect(second.meetingId).not.toBe(first.meetingId);
    expect(await meetingExists(first.meetingId)).toBe(true);
    expect(await recordingRow(withNote)).toMatchObject({ status: 'importing', meeting_id: second.meetingId });
    // A failed try whose meeting is another member's (a row pointing at it): never touched.
    const theirs = String((await rpc('meetings/create', 'otherMember', { title: 'Của người khác', consentMethod: 'told_at_start' })).body.meetingId);
    const pointing = await suggest('recorder');
    await admin((c) => c.query(`UPDATE crove_kernel.meeting_platform_recording SET status = 'failed', meeting_id = $2, error_code = 'timeout' WHERE id = $1`, [pointing, theirs]));
    await startImport('recorder', { recordingId: pointing });
    expect(await meetingExists(theirs)).toBe(true);
    // A meeting the member edited since the import made it (a new title) is kept, and so is one that holds a link to a party.
    const edited = await suggest('recorder');
    const editedFirst = await startImport('recorder', { recordingId: edited });
    await admin((c) => c.query(`UPDATE crove_meetings.meeting SET title = 'Tên tôi sửa', updated_at = created_at + interval '1 second' WHERE id = $1`, [editedFirst.meetingId]));
    await fail(edited);
    await startImport('recorder', { recordingId: edited });
    expect(await meetingExists(editedFirst.meetingId)).toBe(true);
    const linked = await suggest('recorder');
    const linkedFirst = await startImport('recorder', { recordingId: linked });
    await admin(async (c) => {
      const party = await c.query<{ id: string }>(`INSERT INTO crove_kernel.party (org_id, name, kind) VALUES ($1, 'Công ty liên kết', 'organization') RETURNING id`, [orgId]);
      await c.query('INSERT INTO crove_meetings.meeting_link (org_id, meeting_id, party_id, created_by) VALUES ($1, $2, $3, $4)', [orgId, linkedFirst.meetingId, party.rows[0]!.id, userIds.get('recorder')]);
    });
    await fail(linked);
    await startImport('recorder', { recordingId: linked });
    expect(await meetingExists(linkedFirst.meetingId)).toBe(true);
    // A failed row whose meeting is already gone goes straight to a new meeting, with no error.
    const gone = await suggest('recorder');
    const goneFirst = await startImport('recorder', { recordingId: gone });
    await fail(gone);
    await admin((c) => c.query('DELETE FROM crove_meetings.meeting WHERE id = $1', [goneFirst.meetingId]));
    const goneAgain = await startImport('recorder', { recordingId: gone });
    expect(await recordingRow(gone)).toMatchObject({ status: 'importing', meeting_id: goneAgain.meetingId });
    // The removal of an empty meeting is audited as the recorder's own delete, and the import's audit row names the meeting it replaced.
    const retried = await suggest('recorder');
    const retriedFirst = await startImport('recorder', { recordingId: retried });
    await fail(retried);
    const retriedSecond = await startImport('recorder', { recordingId: retried });
    const audit = await admin(async (c) => ({
      deleted: (await c.query(`SELECT 1 FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'meetings.meeting.delete' AND target_id = $2 AND outcome = 'ok'`, [orgId, retriedFirst.meetingId])).rowCount,
      detail: (await c.query<{ detail: Record<string, unknown> }>(`SELECT detail FROM crove_kernel.audit_event WHERE command = 'meetings.import.start' AND detail->>'meetingId' = $1`, [retriedSecond.meetingId])).rows[0]?.detail,
    }));
    expect(audit.deleted).toBe(1);
    expect(audit.detail).toMatchObject({ meetingId: retriedSecond.meetingId, replacedMeetingId: retriedFirst.meetingId });
    // A recording that is importing is not retried at all, and its meeting stays.
    const live = await suggest('recorder');
    const liveMeeting = await startImport('recorder', { recordingId: live });
    expect(await refusedWith(startImport('recorder', { recordingId: live }))).toBe('MEETING_PLATFORM_STATE');
    expect(await meetingExists(liveMeeting.meetingId)).toBe(true);
  });

  it('31c. C1: dismissing a failed recording, or disconnecting its platform, removes the empty meeting of the failed try by the retry\'s rule, and only that (#3587)', async () => {
    const fail = (id: string) => admin((c) => c.query(`UPDATE crove_kernel.meeting_platform_recording SET status = 'failed', staging_key = NULL, error_code = 'timeout' WHERE id = $1`, [id]));
    const dismiss = (who: string, recordingId: string) => runtime.execute('kernel.meeting_platform.recording.dismiss', { recordingId }, { actor: asUser(who), orgId });
    const discard = (who: string, input: Record<string, unknown>) => runtime.execute<{ removed: number }>('meetings.import.discard_empty', input, { actor: asUser(who), orgId });
    const connectionOf = (recordingId: string) => admin(async (c) => (await c.query<{ connection_id: string }>('SELECT connection_id FROM crove_kernel.meeting_platform_recording WHERE id = $1', [recordingId])).rows[0]!.connection_id);
    const note = (meetingId: string) => admin((c) => c.query(`INSERT INTO crove_meetings.meeting_note (org_id, meeting_id, body) VALUES ($1, $2, 'Ghi chú của tôi')`, [orgId, meetingId]));

    // A failed try with an empty meeting: dismissed, then cleaned; the recording row stays as dismissed, the meeting is gone, the removal is audited as the recorder's own delete.
    const empty = await suggest('recorder');
    const emptyMeeting = (await startImport('recorder', { recordingId: empty })).meetingId;
    await fail(empty);
    await dismiss('recorder', empty);
    expect(await meetingExists(emptyMeeting), 'dismissing alone leaves the meeting').toBe(true);
    expect((await discard('recorder', { recordingId: empty })).removed).toBe(1);
    expect(await meetingExists(emptyMeeting)).toBe(false);
    expect(await recordingRow(empty)).toMatchObject({ status: 'dismissed' });
    const audits = await admin(async (c) => ({
      deleted: (await c.query(`SELECT 1 FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'meetings.meeting.delete' AND target_id = $2 AND outcome = 'ok'`, [orgId, emptyMeeting])).rowCount,
      detail: (await c.query<{ detail: Record<string, unknown> }>(`SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'meetings.import.discard_empty' AND detail->>'recordingId' = $2`, [orgId, empty])).rows[0]?.detail,
    }));
    expect(audits.deleted).toBe(1);
    expect(audits.detail).toMatchObject({ recordingId: empty, connectionId: null, removed: 1 });
    // A second call is a no-op.
    expect((await discard('recorder', { recordingId: empty })).removed).toBe(0);

    // A meeting that holds a note, one the member edited, another member's, and a recording that is not failed or dismissed are all kept.
    const withNote = await suggest('recorder');
    const noteMeeting = (await startImport('recorder', { recordingId: withNote })).meetingId;
    await note(noteMeeting);
    await fail(withNote);
    await dismiss('recorder', withNote);
    expect((await discard('recorder', { recordingId: withNote })).removed).toBe(0);
    expect(await meetingExists(noteMeeting)).toBe(true);
    const edited = await suggest('recorder');
    const editedMeeting = (await startImport('recorder', { recordingId: edited })).meetingId;
    await admin((c) => c.query(`UPDATE crove_meetings.meeting SET title = 'Tên tôi sửa', updated_at = created_at + interval '1 second' WHERE id = $1`, [editedMeeting]));
    await fail(edited);
    await dismiss('recorder', edited);
    expect((await discard('recorder', { recordingId: edited })).removed).toBe(0);
    expect(await meetingExists(editedMeeting)).toBe(true);
    const theirs = String((await rpc('meetings/create', 'otherMember', { title: 'Của người khác', consentMethod: 'told_at_start' })).body.meetingId);
    const pointing = await suggest('recorder');
    await admin((c) => c.query(`UPDATE crove_kernel.meeting_platform_recording SET status = 'failed', meeting_id = $2, error_code = 'timeout' WHERE id = $1`, [pointing, theirs]));
    await dismiss('recorder', pointing);
    expect((await discard('recorder', { recordingId: pointing })).removed).toBe(0);
    expect(await meetingExists(theirs)).toBe(true);
    const live = await suggest('recorder');
    const liveMeeting = (await startImport('recorder', { recordingId: live })).meetingId;
    expect((await discard('recorder', { recordingId: live })).removed, 'an importing recording is not cleaned').toBe(0);
    expect(await meetingExists(liveMeeting)).toBe(true);

    // A recording that was only suggested has no meeting: nothing to clean, no error.
    const plain = await suggest('recorder');
    expect((await discard('recorder', { recordingId: plain })).removed).toBe(0);

    // The shape of the request and who may ask: exactly one of the two ids, a recording that is not the member's is not found, a viewer is refused.
    expect(await refusedWith(discard('recorder', {}))).not.toBeNull();
    expect(await refusedWith(discard('recorder', { recordingId: empty, connectionId: await connectionOf(empty) }))).not.toBeNull();
    expect(await refusedWith(discard('otherMember', { recordingId: withNote }))).toBe('MEETING_PLATFORM_NOT_FOUND');
    expect(await refusedWith(discard('viewer', { recordingId: withNote }))).not.toBeNull();
    // Another member's connection id removes nothing of the recorder's, and the answer says so without saying more.
    const foreign = await suggest('recorder');
    const foreignMeeting = (await startImport('recorder', { recordingId: foreign })).meetingId;
    await fail(foreign);
    expect((await discard('otherMember', { connectionId: await connectionOf(foreign) })).removed).toBe(0);
    expect(await meetingExists(foreignMeeting)).toBe(true);

    // The disconnect: every failed or dismissed recording of the connection is looked at before its rows go with it; the empty meeting goes, the one that holds a note stays, an imported one stays.
    const first = await suggest('recorder');
    const connection = await connectionOf(first);
    const second = randomUUID();
    const third = randomUUID();
    await admin(async (c) => {
      for (const id of [second, third]) {
        await c.query(
          `INSERT INTO crove_kernel.meeting_platform_recording (org_id, id, connection_id, user_id, external_id, title, started_at, size_bytes, has_audio) VALUES ($1, $2, $3, $4, $5, 'Họp', now() - interval '90 days', 4096, true)`,
          [orgId, id, connection, userIds.get('recorder'), randomUUID()],
        );
      }
    });
    const firstMeeting = (await startImport('recorder', { recordingId: first })).meetingId;
    const secondMeeting = (await startImport('recorder', { recordingId: second })).meetingId;
    await note(secondMeeting);
    const thirdMeeting = (await startImport('recorder', { recordingId: third })).meetingId;
    await fail(first);
    await fail(second);
    await admin((c) => c.query(`UPDATE crove_kernel.meeting_platform_recording SET status = 'imported', staging_key = NULL WHERE id = $1`, [third]));
    expect((await discard('recorder', { connectionId: connection })).removed).toBe(1);
    expect(await meetingExists(firstMeeting)).toBe(false);
    expect(await meetingExists(secondMeeting)).toBe(true);
    expect(await meetingExists(thirdMeeting)).toBe(true);
    await runtime.execute('kernel.meeting_platform.disconnect', { connectionId: connection }, { actor: asUser('recorder'), orgId });
    expect(await recordingRowCount(connection)).toBe(0);
    expect(await meetingExists(secondMeeting), 'the meeting that holds a note outlives the connection').toBe(true);
  });

  it('32. C1: a meeting that is no import is untouched when its media is recorded', async () => {
    const made = await rpc('meetings/create', 'recorder', { title: 'Not an import', consentMethod: 'told_at_start' });
    expect((await uploadRaw(String(made.body.meetingId), '?kind=audio')).status).toBe(200);
    const imported = await admin(async (c) => Number((await c.query<{ n: string }>(`SELECT count(*) AS n FROM crove_kernel.meeting_platform_recording WHERE meeting_id = $1`, [String(made.body.meetingId)])).rows[0]?.n));
    expect(imported).toBe(0);
  });

  it('33. C1: a platform-notice meeting takes media only as the claimed import of its recorder: an upload, before or after, is refused IMPORT_ONLY and records nothing', async () => {
    const segments = (meetingId: string) =>
      admin(async (c) => Number((await c.query<{ n: string }>('SELECT count(*) AS n FROM crove_meetings.audio_segment WHERE meeting_id = $1', [meetingId])).rows[0]?.n));
    const recordingId = await suggest('recorder');
    const { meetingId } = await startImport('recorder', { recordingId });
    // The recorder's own upload into the import's meeting, while the row is still importing.
    const early = await uploadRaw(meetingId, '?kind=audio');
    expect(early.status).toBe(403);
    expect(((await early.json()) as { code?: string }).code).toBe('IMPORT_ONLY');
    // Staged but not claimed: still an upload, still refused, and the staged bytes stay for the claim.
    const key = await stage(recordingId);
    expect((await uploadRaw(meetingId, '?kind=audio')).status).toBe(403);
    expect(store.staged.has(key)).toBe(true);
    expect(await segments(meetingId)).toBe(0);
    // The claim of that meeting by the same member goes through ...
    expect((await claimImport('recorder', meetingId, { importId: recordingId, kind: 'audio' })).status).toBe(200);
    expect(await segments(meetingId)).toBe(1);
    // ... and once imported the meeting takes no further media from an upload.
    expect((await uploadRaw(meetingId, '?kind=audio')).status).toBe(403);
    expect(await segments(meetingId)).toBe(1);
  });

  it('34. C1: the click goes through the API as meetings/importStart: it returns the meeting, the row is importing, a viewer and a strict org are refused with the command\'s code', async () => {
    const body = { language: 'vi', visibility: 'attendees', consentMethod: 'platform_notice', consentNoticeVersion: IMPORT_NOTICE_VERSION, consentConfirmed: true };
    const recordingId = await suggest('recorder');
    const done = await rpc('meetings/importStart', 'recorder', { recordingId, ...body });
    expect(done.status).toBe(200);
    expect(done.body).toEqual({ meetingId: expect.any(String) });
    expect(await recordingRow(recordingId)).toMatchObject({ status: 'importing', meeting_id: done.body.meetingId });
    // The same input shape is checked at the edge: no consent tick, or another notice, is a 400 and nothing is made.
    const other = await suggest('recorder');
    expect((await rpc('meetings/importStart', 'recorder', { recordingId: other, ...body, consentConfirmed: false })).status).toBe(400);
    expect((await rpc('meetings/importStart', 'recorder', { recordingId: other, ...body, consentNoticeVersion: '2026-11-v1' })).status).toBe(400);
    expect((await rpc('meetings/importStart', 'viewer', { recordingId: other, ...body })).status).toBeGreaterThanOrEqual(400);
    expect((await recordingRow(other)).status).toBe('suggested');
    // A strict org answers CONSENT_METHOD_NOT_ALLOWED, which the app words before the click.
    expect((await rpc('meetings/consentPolicy/set', 'owner', { policy: 'strict' })).status).toBe(200);
    try {
      const refused = await rpc('meetings/importStart', 'recorder', { recordingId: other, ...body });
      expect(refused.status).toBe(422);
      expect(refused.body.code).toBe('CONSENT_METHOD_NOT_ALLOWED');
    } finally {
      expect((await rpc('meetings/consentPolicy/set', 'owner', { policy: 'standard' })).status).toBe(200);
    }
  });
  it('34b. C2a: a recording with only a video file is refused NO_AUDIO unless this deployment can take its audio out, and one with neither file is always refused', async () => {
    const videoOnly = await suggest('recorder', { hasAudio: false, hasVideo: true });
    const neither = await suggest('recorder', { hasAudio: false, hasVideo: false });
    // Off (the default, no MEDIA_URL): refused before a meeting is made, and the row stays suggested.
    expect(await refusedWith(startImport('recorder', { recordingId: videoOnly, language: 'vi', visibility: 'attendees' }))).toBe('MEETING_PLATFORM_NO_AUDIO');
    expect((await recordingRow(videoOnly)).meeting_id).toBeNull();
    expect((await recordingRow(videoOnly)).status).toBe('suggested');
    setMeetingVideoImport(true);
    try {
      // On: the definer lets the video-only row begin and the import starts; neither file is still refused.
      const { meetingId } = await startImport('recorder', { recordingId: videoOnly, language: 'vi', visibility: 'attendees' });
      expect(await recordingRow(videoOnly)).toMatchObject({ status: 'importing', meeting_id: meetingId });
      expect(await refusedWith(startImport('recorder', { recordingId: neither, language: 'vi', visibility: 'attendees' }))).toBe('MEETING_PLATFORM_NO_AUDIO');
      expect((await recordingRow(neither)).status).toBe('suggested');
    } finally {
      setMeetingVideoImport(false);
    }
  });

  it('34c. C2: take_transcript writes the claimed transcript-only recording as a tainted draft of Google\'s transcription, ends the meeting and marks the row imported; anyone else, or any other row, is refused and nothing is written (#3174)', async () => {
    const take = (who: string, input: Record<string, unknown>) =>
      runtime.execute<{ meetingId: string; stored: number }>('meetings.import.take_transcript', input, { actor: asUser(who), orgId });
    const segments = [
      { startSeconds: 1, endSeconds: 4, speakerLabel: 'Nguyễn Văn Nam', text: 'Chào mọi người, ta bắt đầu họp.' },
      { startSeconds: 5, endSeconds: 9, speakerLabel: 'Khách A', text: 'Báo giá cho khách A là 120 triệu.' },
    ];
    const newMeeting = async () => String((await rpc('meetings/create', 'recorder', { title: 'Họp Google Meet', visibility: 'attendees', keepVideo: false, consentMethod: 'told_at_start' })).body.meetingId);
    const claimed = async (meetingId: string, over: { hasAudio?: boolean; status?: string; owner?: string } = {}) => {
      const recordingId = await suggest(over.owner ?? 'recorder', { hasAudio: over.hasAudio ?? false, hasTranscript: true });
      await admin((c) =>
        c.query(`UPDATE crove_kernel.meeting_platform_recording SET status = $2, meeting_id = $3, staging_key = $4, length_seconds = 600 WHERE id = $1`, [recordingId, over.status ?? 'claimed', meetingId, `staging/${randomBytes(32).toString('hex')}`]),
      );
      return recordingId;
    };
    const stored = (meetingId: string) =>
      admin(async (c) => (await c.query<{ source: string; tainted: boolean; stage: string; speaker_label: string }>('SELECT source, tainted, stage, speaker_label FROM crove_meetings.transcript_segment WHERE meeting_id = $1 ORDER BY start_seconds', [meetingId])).rows);

    // Not the recorder, no claimed row, an unclaimed row and a row with audio: each is refused and writes nothing.
    const meetingId = await newMeeting();
    expect(await refusedWith(take('recorder', { meetingId, segments }))).toBe('IMPORT_NOT_CLAIMED');
    const recordingId = await claimed(meetingId);
    expect(await refusedWith(take('attendee', { meetingId, segments }))).toMatch(/FORBIDDEN|MEETING_NOT_FOUND/);
    const unclaimed = await newMeeting();
    await claimed(unclaimed, { status: 'staged' });
    expect(await refusedWith(take('recorder', { meetingId: unclaimed, segments }))).toBe('IMPORT_NOT_CLAIMED');
    const withAudio = await newMeeting();
    await claimed(withAudio, { hasAudio: true });
    expect(await refusedWith(take('recorder', { meetingId: withAudio, segments }))).toBe('IMPORT_NOT_CLAIMED');
    // A claimed transcript-only row that belongs to ANOTHER member is no claim of this recorder.
    const foreign = await newMeeting();
    await claimed(foreign, { owner: 'attendee' });
    expect(await refusedWith(take('recorder', { meetingId: foreign, segments }))).toBe('IMPORT_NOT_CLAIMED');
    for (const id of [meetingId, unclaimed, withAudio, foreign]) expect(await stored(id)).toEqual([]);
    expect(await recordingRow(recordingId)).toMatchObject({ status: 'claimed' });
    // The database backs the label: a line that is not Ludy's own is born tainted whoever inserts it, and its source never changes.
    const insertLine = (tainted: boolean) =>
      admin((c) => c.query(`INSERT INTO crove_meetings.transcript_segment (org_id, meeting_id, start_seconds, end_seconds, text, source, tainted) VALUES ($1, $2, 0, 1, 'x', 'google_meet', $3)`, [orgId, meetingId, tainted]));
    await expect(insertLine(false)).rejects.toThrow(/MEETINGS_TAINT_FORBIDDEN/);

    // The claimed transcript-only row of the recorder: written as Google's tainted draft.
    expect(await take('recorder', { meetingId, segments })).toEqual({ meetingId, stored: 2 });
    expect(await stored(meetingId)).toEqual([
      { source: 'google_meet', tainted: true, stage: 'draft', speaker_label: 'Nguyễn Văn Nam' },
      { source: 'google_meet', tainted: true, stage: 'draft', speaker_label: 'Khách A' },
    ]);
    expect(await recordingRow(recordingId)).toMatchObject({ status: 'imported', staging_key: null });
    expect(await admin(async (c) => (await c.query<{ e: boolean }>('SELECT ended_at IS NOT NULL AS e FROM crove_meetings.meeting WHERE id = $1', [meetingId])).rows[0]?.e)).toBe(true);
    // The recorder reads it back labelled as Google's, a correction keeps the label, and the audit row holds ids and a count, never a line.
    const read = await rpc('meetings/transcript/get', 'recorder', { meetingId });
    expect((read.body as { segments: { source: string }[] }).segments.map((x) => x.source)).toEqual(['google_meet', 'google_meet']);
    const first = (read.body as { segments: { id: string }[] }).segments[0]!;
    expect((await rpc('meetings/transcript/correct', 'recorder', { segmentId: first.id, text: 'Chào cả nhà, bắt đầu họp.' })).status).toBe(200);
    expect((await stored(meetingId)).map((x) => x.source)).toEqual(['google_meet', 'google_meet']);
    const audit = await admin(async (c) => (await c.query<{ detail: Record<string, unknown> }>(`SELECT detail FROM crove_kernel.audit_event WHERE command = 'meetings.import.take_transcript' AND detail->>'meetingId' = $1`, [meetingId])).rows[0]?.detail);
    expect(audit).toMatchObject({ meetingId, recordingId, stored: 2, source: 'google_meet' });
    expect(JSON.stringify(audit)).not.toContain('120 triệu');
    await expect(admin((c) => c.query(`UPDATE crove_meetings.transcript_segment SET source = 'ludy' WHERE meeting_id = $1`, [meetingId]))).rejects.toThrow(/MEETINGS_TAINT_FORBIDDEN/);
    await expect(admin((c) => c.query(`INSERT INTO crove_meetings.transcript_segment (org_id, meeting_id, start_seconds, end_seconds, text, source, tainted) VALUES ($1, $2, 0, 1, 'x', 'someone_else', true)`, [orgId, meetingId]))).rejects.toThrow(/transcript_segment_source_check/);
    // Taken once: the row is imported now, so the same call is refused.
    expect(await refusedWith(take('recorder', { meetingId, segments }))).toBe('IMPORT_NOT_CLAIMED');
  });


  it('34d. C4: a transcript taken through a Teams connection is labelled Microsoft\'s, tainted and unchangeable; a maker the table does not know is refused (#3176)', async () => {
    const segments = [{ startSeconds: 1, endSeconds: 4, speakerLabel: 'Trần Thị Lan', text: 'Chào mọi người, ta bắt đầu họp.' }];
    const meetingId = String((await rpc('meetings/create', 'recorder', { title: 'Họp Teams', visibility: 'attendees', keepVideo: false, consentMethod: 'told_at_start' })).body.meetingId);
    const recordingId = await suggest('recorder', { hasAudio: false, hasTranscript: true, provider: 'microsoft_teams' });
    await admin((c) =>
      c.query(`UPDATE crove_kernel.meeting_platform_recording SET status = 'claimed', meeting_id = $2, staging_key = $3, length_seconds = 600 WHERE id = $1`, [recordingId, meetingId, `staging/${randomBytes(32).toString('hex')}`]),
    );
    expect(await runtime.execute('meetings.import.take_transcript', { meetingId, segments }, { actor: asUser('recorder'), orgId })).toEqual({ meetingId, stored: 1 });
    const rows = await admin(async (c) => (await c.query<{ source: string; tainted: boolean }>('SELECT source, tainted FROM crove_meetings.transcript_segment WHERE meeting_id = $1', [meetingId])).rows);
    expect(rows).toEqual([{ source: 'microsoft_teams', tainted: true }]);
    const read = await rpc('meetings/transcript/get', 'recorder', { meetingId });
    expect((read.body as { segments: { source: string }[] }).segments.map((x) => x.source)).toEqual(['microsoft_teams']);
    const audit = await admin(async (c) => (await c.query<{ detail: Record<string, unknown> }>(`SELECT detail FROM crove_kernel.audit_event WHERE command = 'meetings.import.take_transcript' AND detail->>'meetingId' = $1`, [meetingId])).rows[0]?.detail);
    expect(audit).toMatchObject({ meetingId, recordingId, stored: 1, source: 'microsoft_teams' });
    expect(JSON.stringify(audit)).not.toContain('Chào mọi người');
    // The database still backs the label: a Teams line untainted is refused, its source never changes, and an unknown maker is refused by the CHECK.
    const insert = (source: string, tainted: boolean) =>
      admin((c) => c.query(`INSERT INTO crove_meetings.transcript_segment (org_id, meeting_id, start_seconds, end_seconds, text, source, tainted) VALUES ($1, $2, 0, 1, 'x', $3, $4)`, [orgId, meetingId, source, tainted]));
    await expect(insert('microsoft_teams', false)).rejects.toThrow(/MEETINGS_TAINT_FORBIDDEN/);
    await expect(insert('zoom', true)).rejects.toThrow(/transcript_segment_source_check/);
    await expect(admin((c) => c.query(`UPDATE crove_meetings.transcript_segment SET source = 'google_meet' WHERE meeting_id = $1`, [meetingId]))).rejects.toThrow(/MEETINGS_TAINT_FORBIDDEN/);
    // A provider with no transcript path (Zoom) is refused and writes nothing: it is never labelled as another platform's.
    const zoomMeeting = String((await rpc('meetings/create', 'recorder', { title: 'Họp Zoom', visibility: 'attendees', keepVideo: false, consentMethod: 'told_at_start' })).body.meetingId);
    const zoomRecording = await suggest('recorder', { hasAudio: false, hasTranscript: true, provider: 'zoom' });
    await admin((c) =>
      c.query(`UPDATE crove_kernel.meeting_platform_recording SET status = 'claimed', meeting_id = $2, staging_key = $3, length_seconds = 600 WHERE id = $1`, [zoomRecording, zoomMeeting, `staging/${randomBytes(32).toString('hex')}`]),
    );
    expect(await refusedWith(runtime.execute('meetings.import.take_transcript', { meetingId: zoomMeeting, segments }, { actor: asUser('recorder'), orgId }))).toBe('IMPORT_NOT_CLAIMED');
    expect(await admin(async (c) => Number((await c.query<{ n: string }>('SELECT count(*) AS n FROM crove_meetings.transcript_segment WHERE meeting_id = $1', [zoomMeeting])).rows[0]?.n))).toBe(0);
  });

  it('34e. C2: a transcript-only recording begins when its provider has a transcript path (Zoom has none), and the import route takes the staged lines as the recorder\'s draft and deletes them (#3174)', async () => {
    const postTranscript = async (who: string, meetingId: string, body: unknown) => {
      const response = await app.request(`/api/meetings/${meetingId}/transcript-import`, {
        method: 'POST',
        headers: { authorization: `Bearer ${await token(who)}`, 'content-type': 'application/json', 'x-crove-org': slug },
        body: JSON.stringify(body),
      });
      return response.status;
    };
    const staged = (lines: unknown) => Buffer.from(JSON.stringify({ segments: lines }));
    const lines = [
      { startSeconds: 1, endSeconds: 4, speakerLabel: 'Trần Thị Lan', text: 'Chào mọi người, ta bắt đầu họp.' },
      { startSeconds: 5, endSeconds: 9, speakerLabel: 'Người nói', text: 'Đơn hàng 120 triệu đã được duyệt.' },
    ];
    const begin = async (over: { provider?: string } = {}) => {
      const recordingId = await suggest('recorder', { hasAudio: false, hasTranscript: true, ...over });
      const { meetingId } = await startImport('recorder', { recordingId, language: 'vi', visibility: 'attendees' });
      return { recordingId, meetingId };
    };
    // A provider with no transcript path is refused before a meeting is made.
    const zoomOnly = await suggest('recorder', { hasAudio: false, hasTranscript: true, provider: 'zoom' });
    const meetingsBefore = await meetingCount();
    expect(await refusedWith(startImport('recorder', { recordingId: zoomOnly, language: 'vi', visibility: 'attendees' }))).toBe('MEETING_PLATFORM_NO_AUDIO');
    expect(await meetingCount()).toBe(meetingsBefore);
    expect((await recordingRow(zoomOnly)).status).toBe('suggested');

    // The sandbox (a transcript-only recording) begins; the worker stages the lines; the member's request takes them.
    const first = await begin();
    expect(await recordingRow(first.recordingId)).toMatchObject({ status: 'importing', meeting_id: first.meetingId });
    const key = await stage(first.recordingId, staged(lines));
    // Not the recorder, a wrong or missing id, and another meeting's id: refused, and the row is still the member's to claim.
    expect(await postTranscript('otherMember', first.meetingId, { importId: first.recordingId })).toBeGreaterThanOrEqual(400);
    expect(await postTranscript('recorder', first.meetingId, {})).toBe(400);
    expect(await postTranscript('recorder', first.meetingId, { importId: 'not-a-uuid' })).toBe(400);
    const second = await begin();
    expect(await postTranscript('recorder', second.meetingId, { importId: first.recordingId })).toBeGreaterThanOrEqual(400);
    expect((await recordingRow(first.recordingId)).status).toBe('staged');
    expect(store.staged.has(key)).toBe(true);
    // The recorder takes it: the lines are the recorder's tainted draft of Google's transcription, the row is imported, the meeting ended and the staged bytes are gone.
    expect(await postTranscript('recorder', first.meetingId, { importId: first.recordingId })).toBe(200);
    const rows = await admin(async (c) => (await c.query<{ text: string; source: string; tainted: boolean }>('SELECT text, source, tainted FROM crove_meetings.transcript_segment WHERE meeting_id = $1 ORDER BY start_seconds', [first.meetingId])).rows);
    expect(rows.map((r) => ({ source: r.source, tainted: r.tainted }))).toEqual([{ source: 'google_meet', tainted: true }, { source: 'google_meet', tainted: true }]);
    expect(rows[1]?.text).toBe('Đơn hàng 120 triệu đã được duyệt.');
    expect(await recordingRow(first.recordingId)).toMatchObject({ status: 'imported', staging_key: null });
    expect(store.staged.has(key)).toBe(false);
    expect(await admin(async (c) => (await c.query<{ ended: boolean }>('SELECT ended_at IS NOT NULL AS ended FROM crove_meetings.meeting WHERE id = $1', [first.meetingId])).rows[0]?.ended)).toBe(true);
    // Taken once: a second request finds nothing to claim.
    expect(await postTranscript('recorder', first.meetingId, { importId: first.recordingId })).toBeGreaterThanOrEqual(400);

    // A whole transcript leaves the meeting's flag false (#3922).
    const cutFlag = async (meetingId: string) => ((await rpc('meetings/get', 'recorder', { meetingId })).body as { platformTranscriptCut: boolean }).platformTranscriptCut;
    expect(await cutFlag(first.meetingId)).toBe(false);
    // A transcript the worker had to cut (the staged file says `truncated: true`): taken as before, and the meeting keeps the fact for its page; only a literal true counts.
    const cutOne = await begin();
    await stage(cutOne.recordingId, Buffer.from(JSON.stringify({ segments: lines, truncated: true })));
    expect(await postTranscript('recorder', cutOne.meetingId, { importId: cutOne.recordingId })).toBe(200);
    expect(await cutFlag(cutOne.meetingId)).toBe(true);
    // The audit row holds ids, the platform and a count and a boolean, never a line.
    const cutAudit = await admin(async (c) => (await c.query<{ detail: Record<string, unknown> }>(`SELECT detail FROM crove_kernel.audit_event WHERE command = 'meetings.import.take_transcript' AND detail->>'meetingId' = $1`, [cutOne.meetingId])).rows[0]?.detail);
    expect(cutAudit).toMatchObject({ meetingId: cutOne.meetingId, stored: 2, source: 'google_meet', cut: true });
    expect(JSON.stringify(cutAudit)).not.toContain('120 triệu');
    // The note does not outlive the partial draft: the recorder's own transcription replaces it and clears the flag.
    await runtime.execute('meetings.transcript.draft_store', { meetingId: cutOne.meetingId, segments: [{ startSeconds: 0, endSeconds: 2, speakerLabel: 'Lan', text: 'Bản mới.' }] }, { actor: asUser('recorder'), orgId });
    expect(await cutFlag(cutOne.meetingId)).toBe(false);
    for (const notTrue of ['true', 1, null]) {
      const loose = await begin();
      await stage(loose.recordingId, Buffer.from(JSON.stringify({ segments: lines, truncated: notTrue })));
      expect(await postTranscript('recorder', loose.meetingId, { importId: loose.recordingId })).toBe(200);
      expect(await cutFlag(loose.meetingId), JSON.stringify(notTrue)).toBe(false);
    }

    // Bytes that are not the lines (not JSON, an empty text, no lines): refused as the platform's file, the row fails with a short code, no line is written and the bytes are deleted.
    for (const bad of [Buffer.from('not json'), staged([{ startSeconds: 0, endSeconds: 1, speakerLabel: 'x', text: '' }]), staged([])]) {
      const next = await begin();
      const badKey = await stage(next.recordingId, bad);
      expect(await postTranscript('recorder', next.meetingId, { importId: next.recordingId })).toBe(400);
      expect(await recordingRow(next.recordingId)).toMatchObject({ status: 'failed', error_code: 'claim_failed' });
      expect(store.staged.has(badKey)).toBe(false);
      expect(await admin(async (c) => Number((await c.query<{ n: string }>('SELECT count(*) AS n FROM crove_meetings.transcript_segment WHERE meeting_id = $1', [next.meetingId])).rows[0]?.n))).toBe(0);
    }
  });

  it('34f. C2 follow-up (#3923): each import route refuses a row of the other kind before the claim moves it, so the row stays staged with its bytes for the right request', async () => {
    const postTranscript = async (meetingId: string, importId: string) => {
      const response = await app.request(`/api/meetings/${meetingId}/transcript-import`, {
        method: 'POST',
        headers: { authorization: `Bearer ${await token('recorder')}`, 'content-type': 'application/json', 'x-crove-org': slug },
        body: JSON.stringify({ importId }),
      });
      return response.status;
    };
    // An audio recording posted to the transcript route: refused, still staged, bytes kept.
    const audioId = await suggest('recorder');
    const audio = await startImport('recorder', { recordingId: audioId, language: 'vi', visibility: 'attendees' });
    const audioKey = await stage(audioId);
    expect(await postTranscript(audio.meetingId, audioId)).toBe(400);
    expect((await recordingRow(audioId)).status).toBe('staged');
    expect(store.staged.has(audioKey)).toBe(true);
    // A transcript-only recording posted to the media route: refused, still staged, bytes kept.
    const textId = await suggest('recorder', { hasAudio: false, hasTranscript: true });
    const text = await startImport('recorder', { recordingId: textId, language: 'vi', visibility: 'attendees' });
    const textKey = await stage(textId, Buffer.from(JSON.stringify({ segments: [{ startSeconds: 0, endSeconds: 2, speakerLabel: 'Lan', text: 'Xin chào.' }] })));
    expect((await claimImport('recorder', text.meetingId, { importId: textId, kind: 'audio' })).status).toBe(400);
    expect((await recordingRow(textId)).status).toBe('staged');
    expect(store.staged.has(textKey)).toBe(true);
    // The right routes still take them.
    expect(await postTranscript(text.meetingId, textId)).toBe(200);
    expect((await recordingRow(textId)).status).toBe('imported');
    expect((await claimImport('recorder', audio.meetingId, { importId: audioId, kind: 'audio' })).status).toBe(200);
  });

  it('34g. C2 follow-up (#4000): the wrong-route refusal finds the row by its id, so a row older than the 50 newest is refused too and stays staged', async () => {
    const postTranscript = async (meetingId: string, importId: string) => {
      const response = await app.request(`/api/meetings/${meetingId}/transcript-import`, {
        method: 'POST',
        headers: { authorization: `Bearer ${await token('recorder')}`, 'content-type': 'application/json', 'x-crove-org': slug },
        body: JSON.stringify({ importId }),
      });
      return response.status;
    };
    // Two old recordings, one of each kind, begun and staged; then 51 newer ones of the member's, which push both out of the list of the 50 newest.
    const oldest = new Date(Date.now() - 400 * 86_400_000).toISOString();
    const audioId = await suggest('recorder', { startedAt: oldest });
    const audio = await startImport('recorder', { recordingId: audioId, language: 'vi', visibility: 'attendees' });
    const audioKey = await stage(audioId);
    const textId = await suggest('recorder', { startedAt: oldest, hasAudio: false, hasTranscript: true });
    const text = await startImport('recorder', { recordingId: textId, language: 'vi', visibility: 'attendees' });
    const textKey = await stage(textId, Buffer.from(JSON.stringify({ segments: [{ startSeconds: 0, endSeconds: 2, speakerLabel: 'Lan', text: 'Xin chào.' }] })));
    for (let i = 0; i < 51; i += 1) await suggest('recorder', { title: `Họp mới ${i}`, startedAt: new Date(Date.now() - i * 60_000).toISOString() });
    const listed = await runtime.query<Array<{ id: string }>>('kernel.meeting_platform.recordings', {}, { actor: asUser('recorder'), orgId });
    expect(listed).toHaveLength(50);
    expect(listed.map((r) => r.id)).not.toContain(audioId);
    expect(listed.map((r) => r.id)).not.toContain(textId);
    // By its id the query finds an old row, and only that one; an id that is not the member's own finds nothing.
    expect((await runtime.query<Array<{ id: string }>>('kernel.meeting_platform.recordings', { recordingId: audioId }, { actor: asUser('recorder'), orgId })).map((r) => r.id)).toEqual([audioId]);
    expect(await runtime.query<unknown[]>('kernel.meeting_platform.recordings', { recordingId: audioId }, { actor: asUser('otherMember'), orgId })).toEqual([]);
    // #4102: another org does not find it either, though the caller is the very member who owns the row (the org filter alone holds).
    const otherOrg = await rpc('org/create', 'recorder', { name: `Meetings Lookup Org ${randomUUID().slice(0, 6)}`, idempotencyKey: randomUUID() }, null);
    expect(otherOrg.status).toBe(200);
    expect(await runtime.query<unknown[]>('kernel.meeting_platform.recordings', { recordingId: audioId }, { actor: asUser('recorder'), orgId: String(otherOrg.body.orgId) })).toEqual([]);
    // Each route still refuses the other kind before the claim moves the row, though neither row is among the 50 newest.
    expect(await postTranscript(audio.meetingId, audioId)).toBe(400);
    expect((await recordingRow(audioId)).status).toBe('staged');
    expect(store.staged.has(audioKey)).toBe(true);
    expect((await claimImport('recorder', text.meetingId, { importId: textId, kind: 'audio' })).status).toBe(400);
    expect((await recordingRow(textId)).status).toBe('staged');
    expect(store.staged.has(textKey)).toBe(true);
  });

  it('35. #3337: a video uploaded with extract=audio keeps only the extracted Opus, whatever the shape of the upload', async () => {
    const mp4 = Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x18]), Buffer.from('ftypmp42'), Buffer.from('video frames '.repeat(300))]);
    const opus = Buffer.concat([Buffer.from([0x4f, 0x67, 0x67, 0x53, 0x00, 0x02]), Buffer.from('extracted opus '.repeat(20))]);
    const headers = async (extra: Record<string, string> = {}) => ({ authorization: `Bearer ${await token('recorder')}`, 'x-crove-org': slug, ...extra });
    const newMeeting = async (title: string) => String((await rpc('meetings/create', 'recorder', { title, visibility: 'attendees', keepVideo: true, consentMethod: 'told_at_start' })).body.meetingId);
    const count = async (table: 'audio_segment' | 'meeting_video', meetingId: string) =>
      admin(async (c) => Number((await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM crove_meetings.${table} WHERE meeting_id = $1`, [meetingId])).rows[0]!.n));
    const raw = (target: ReturnType<typeof createHttpApp>, meetingId: string, query: string, body: Buffer, type = 'video/mp4') =>
      headers({ 'content-type': type, 'content-length': String(body.length) }).then((h) => target.request(`/api/meetings/${meetingId}/media${query}`, { method: 'POST', headers: h, body: new Uint8Array(body) }));
    const objectsBefore = store.storage.size;

    // The raw body: the video is read by the extractor, and only the Opus is sealed, recorded and played back.
    const extractor = fakeAudioExtractor(opus);
    const withExtractor = createHttpApp({ ...deps, mediaExtractor: extractor });
    const meetingId = await newMeeting('Video as audio');
    const up = await raw(withExtractor, meetingId, '?kind=audio&extract=audio', mp4);
    expect(up.status).toBe(200);
    expect(extractor.calls).toBe(1);
    expect(extractor.read[0]!.equals(mp4)).toBe(true);
    // One object in the store (the Opus sealed as the audio), the temporary sealed video is gone, and no video row exists.
    expect(store.storage.size).toBe(objectsBefore + 1);
    expect(await count('meeting_video', meetingId)).toBe(0);
    const rows = await admin(async (c) => (await c.query<{ length_seconds: number; content_type: string }>('SELECT s.length_seconds, f.content_type FROM crove_meetings.audio_segment s JOIN crove_kernel.file f ON f.org_id = s.org_id AND f.id = s.file_id WHERE s.meeting_id = $1', [meetingId])).rows);
    expect(rows).toEqual([{ length_seconds: 1800, content_type: 'audio/ogg' }]);
    const played = await withExtractor.request(`/api/meetings/${meetingId}/audio`, { headers: await headers() });
    expect(played.status).toBe(200);
    expect(played.headers.get('content-type')).toContain('audio/ogg');
    const playedBytes = Buffer.from(await played.arrayBuffer());
    expect(playedBytes.equals(opus)).toBe(true);
    expect(playedBytes.equals(mp4)).toBe(false);

    // A video with no audio track: 422 NO_AUDIO_TRACK and nothing stored.
    const silentId = await newMeeting('Silent video');
    const silent = await raw(createHttpApp({ ...deps, mediaExtractor: fakeAudioExtractor(opus, { fail: new DomainError('NO_AUDIO_TRACK', 422, 'The video has no audio track') }) }), silentId, '?kind=audio&extract=audio', mp4);
    expect(silent.status).toBe(422);
    expect(((await silent.json()) as { code?: string }).code).toBe('NO_AUDIO_TRACK');
    expect(store.storage.size).toBe(objectsBefore + 1);
    expect(await count('audio_segment', silentId)).toBe(0);

    // Without crove-media: refused before one byte of the body is read.
    let pulled = false;
    const unconfigured = createHttpApp({ ...deps, mediaExtractor: mediaAudioExtractorFor(undefined) });
    const unset = await unconfigured.request(`/api/meetings/${silentId}/media?kind=audio&extract=audio`, {
      method: 'POST',
      headers: await headers({ 'content-type': 'video/mp4', 'content-length': String(mp4.length) }),
      body: new ReadableStream<Uint8Array>({ pull: () => void (pulled = true) }, { highWaterMark: 0 }),
      duplex: 'half',
    } as RequestInit);
    expect(unset.status).toBe(503);
    expect(((await unset.json()) as { code?: string }).code).toBe('MEDIA_PROBE_UNAVAILABLE');
    expect(pulled).toBe(false);

    // The flag is only for kind audio, and not for a platform import claim.
    expect((await raw(withExtractor, silentId, '?kind=video&extract=audio', mp4)).status).toBe(400);
    expect((await raw(withExtractor, silentId, '?kind=audio&extract=video', mp4)).status).toBe(400);
    const jsonPost = async (query: string, body: unknown) => withExtractor.request(`/api/meetings/${silentId}/media${query}`, { method: 'POST', headers: await headers({ 'content-type': 'application/json' }), body: JSON.stringify(body) });
    expect((await jsonPost('?extract=audio', { uploadId: randomUUID(), kind: 'video' })).status).toBe(400);
    expect((await jsonPost('?extract=audio', { importId: randomUUID(), kind: 'audio' })).status).toBe(400);
    const form400 = new FormData();
    form400.append('kind', 'video');
    form400.append('extract', 'audio');
    form400.append('file', new Blob([new Uint8Array(mp4)], { type: 'video/mp4' }), 'm.mp4');
    expect((await withExtractor.request(`/api/meetings/${silentId}/media`, { method: 'POST', headers: await headers(), body: form400 })).status).toBe(400);

    // The input cap is the video cap: a declared length over it is refused before the body is read; a file that is no video container is refused and stores nothing.
    pulled = false;
    const huge = await withExtractor.request(`/api/meetings/${silentId}/media?kind=audio&extract=audio`, {
      method: 'POST',
      headers: await headers({ 'content-type': 'video/mp4', 'content-length': String(3 * 1024 * 1024 * 1024) }),
      body: new ReadableStream<Uint8Array>({ pull: () => void (pulled = true) }, { highWaterMark: 0 }),
      duplex: 'half',
    } as RequestInit);
    expect(huge.status).toBe(413);
    expect(pulled).toBe(false);
    const callsBefore = extractor.calls;
    const notVideo = await raw(withExtractor, silentId, '?kind=audio&extract=audio', Buffer.concat([Buffer.from('OggS'), Buffer.alloc(200, 1)]), 'audio/ogg');
    expect(notVideo.status).toBe(400);
    expect(((await notVideo.json()) as { code?: string }).code).toBe('INVALID_MEDIA_CONTAINER');
    expect(extractor.calls).toBe(callsBefore);
    expect(store.storage.size).toBe(objectsBefore + 1);

    // The extraction takes the same slot as a video upload: a second concurrent video-sized transfer is busy.
    const videoUploads = new ConcurrencyLimiter({ total: 1, perKey: 1 });
    const held = videoUploads.tryAcquire('another-transfer');
    expect(held).not.toBeNull();
    const busyApp = createHttpApp({ ...deps, mediaExtractor: extractor, videoUploads });
    const busy = await raw(busyApp, silentId, '?kind=audio&extract=audio', mp4);
    expect(busy.status).toBe(503);
    expect(busy.headers.get('retry-after')).not.toBeNull();
    held!();
    const freed = await raw(busyApp, silentId, '?kind=audio&extract=audio', mp4);
    expect(freed.status).toBe(200);
    await vi.waitFor(() => expect(videoUploads.inUse).toBe(0));
    expect(store.storage.size).toBe(objectsBefore + 2);

    // The JSON shape: a staged upload (granted for video, which is how the app stages a video it extracts) is read from the store and goes the same way.
    const stagedId = await newMeeting('Staged video as audio');
    const uploadId = randomUUID();
    const stagingKey = `staging/${randomBytes(32).toString('hex')}`;
    store.staged.set(stagingKey, mp4);
    await admin(async (c) => {
      await c.query(
        `INSERT INTO crove_kernel.file_upload (org_id, id, staging_key, created_by, max_bytes, purpose, created_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, 'meeting_video', now(), now() + interval '5 minutes')`,
        [orgId, uploadId, stagingKey, userIds.get('recorder'), 10_000_000],
      );
    });
    const staged = await withExtractor.request(`/api/meetings/${stagedId}/media?extract=audio`, { method: 'POST', headers: await headers({ 'content-type': 'application/json' }), body: JSON.stringify({ uploadId, kind: 'audio' }) });
    expect(staged.status).toBe(200);
    expect(store.staged.has(stagingKey)).toBe(false);
    expect(extractor.read.at(-1)!.equals(mp4)).toBe(true);
    expect(await count('meeting_video', stagedId)).toBe(0);
    expect(store.storage.size).toBe(objectsBefore + 3);

    // The multipart shape: the flag as a form field.
    const formId = await newMeeting('Form video as audio');
    const form = new FormData();
    form.append('kind', 'audio');
    form.append('extract', 'audio');
    form.append('file', new Blob([new Uint8Array(mp4)], { type: 'video/mp4' }), 'zoom.mp4');
    const multipart = await withExtractor.request(`/api/meetings/${formId}/media`, { method: 'POST', headers: await headers(), body: form });
    expect(multipart.status).toBe(200);
    expect(extractor.read.at(-1)!.equals(mp4)).toBe(true);
    expect(await count('meeting_video', formId)).toBe(0);
    expect(store.storage.size).toBe(objectsBefore + 4);
    // Without crove-media the form is refused too (after its parse), and stores nothing.
    const formId2 = await newMeeting('Form video, no sandbox');
    const form2 = new FormData();
    form2.append('kind', 'audio');
    form2.append('extract', 'audio');
    form2.append('file', new Blob([new Uint8Array(mp4)], { type: 'video/mp4' }), 'zoom.mp4');
    const unsetForm = await unconfigured.request(`/api/meetings/${formId2}/media`, { method: 'POST', headers: await headers(), body: form2 });
    expect(unsetForm.status).toBe(503);
    expect(store.storage.size).toBe(objectsBefore + 4);
  });
});

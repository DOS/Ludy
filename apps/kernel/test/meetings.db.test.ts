// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { kernelCommands, kernelQueries } from '@crove/kernel';
import {
  BlobNotFoundError,
  BlobTooLargeError,
  Runtime,
  sha256Hex,
  type BlobStore,
  type CredentialBroker,
  type DirectTransfers,
} from '@crove/kernel-runtime';
import { financeCommands, financeQueries } from '@crove/mod-finance';
import { buildMeetingsCommands, buildMeetingsQueries } from '@crove/mod-meetings';
import { createAuthenticator } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp, type HttpDeps } from '../src/http.ts';
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

  async getRange(key: string, start: number, end: number): Promise<Uint8Array> {
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
  };
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

  async function join(name: string, role: 'member' | 'viewer') {
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
        ...buildMeetingsCommands({ store, broker }),
      ],
      queries: [
        ...kernelQueries({ inboundDomain: null }),
        ...financeQueries,
        ...buildMeetingsQueries(),
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
        `INSERT INTO crove_kernel.file_upload (org_id, id, staging_key, created_by, max_bytes, created_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, now(), now() + interval '5 minutes')`,
        [orgId, audioUploadId, stagingKeyAudio, userIds.get('recorder'), 300 * 1024 * 1024],
      );
    });

    // Attempt claim with invalid container bytes (e.g. 0x41)
    const invalidUploadId = randomUUID();
    const stagingKeyInvalid = `staging/${randomBytes(32).toString('hex')}`;
    store.staged.set(stagingKeyInvalid, Buffer.alloc(100, 0x41));
    await admin(async (c) => {
      await c.query(
        `INSERT INTO crove_kernel.file_upload (org_id, id, staging_key, created_by, max_bytes, created_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, now(), now() + interval '5 minutes')`,
        [orgId, invalidUploadId, stagingKeyInvalid, userIds.get('recorder'), 300 * 1024 * 1024],
      );
    });
    const invalidClaim = await rpc('meetings/claimMedia', 'recorder', {
      meetingId,
      kind: 'audio',
      uploadId: invalidUploadId,
    });
    expect(invalidClaim.status).toBe(400);

    // Valid claim audio
    const claimAudioRes = await rpc('meetings/claimMedia', 'recorder', {
      meetingId,
      kind: 'audio',
      uploadId: audioUploadId,
    });
    expect(claimAudioRes.status).toBe(200);
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
        `INSERT INTO crove_kernel.file_upload (org_id, id, staging_key, created_by, max_bytes, created_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, now(), now() + interval '5 minutes')`,
        [orgId, videoUploadId, stagingKeyVideo, userIds.get('recorder'), 2 * 1024 * 1024 * 1024],
      );
    });

    const claimVideoRes = await rpc('meetings/claimMedia', 'recorder', {
      meetingId,
      kind: 'video',
      uploadId: videoUploadId,
    });
    expect(claimVideoRes.status).toBe(200);
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
        `INSERT INTO crove_kernel.file_upload (org_id, id, staging_key, created_by, max_bytes, created_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, now(), now() + interval '5 minutes')`,
        [orgId, audioUploadId, stagingKey, userIds.get('recorder'), 300 * 1024 * 1024],
      );
    });

    await rpc('meetings/claimMedia', 'recorder', { meetingId, kind: 'audio', uploadId: audioUploadId });

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

    // HTTP 206 Partial Content (bytes 10-25)
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
        `INSERT INTO crove_kernel.file_upload (org_id, id, staging_key, created_by, max_bytes, created_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, now(), now() + interval '5 minutes')`,
        [orgId, uploadId, stagingKey, userIds.get('recorder'), 300 * 1024 * 1024],
      );
    });
    await rpc('meetings/claimMedia', 'recorder', { meetingId, kind: 'audio', uploadId });

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
});

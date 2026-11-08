// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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
import { meetingsCommands, meetingsQueries } from '@crove/mod-meetings';
import { createAuthenticator } from '../src/auth.ts';
import { resealCredentials } from '../src/credential-reseal.ts';
import { loadConfig } from '../src/config.ts';
import { ConcurrencyLimiter } from '../src/concurrency.ts';
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
        headers: { authorization: `Bearer ${await token(who)}`, 'x-crove-org': slug, 'content-type': type },
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
});

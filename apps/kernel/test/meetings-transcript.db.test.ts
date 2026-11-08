// SPDX-License-Identifier: AGPL-3.0-only
// The transcript of a meeting on a real database (#2578, M4a): only the recorder reads, stores and corrects a draft; a reader of
// the meeting reads published segments only; the audit rows hold ids and counts, never text; the transcript goes with its
// meeting; and all of it works with AI off (the deployment here has none).
import { createHash, randomUUID } from 'node:crypto';
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
import { meetingsCommands, meetingsQueries } from '@crove/mod-meetings';
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

suite('the meeting transcript (#2578, M4a)', () => {
  const dbName = `crove_test_transcript_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let store: TestBlobStore;
  let broker: CredentialBroker;
  let app: ReturnType<typeof createHttpApp>;
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
      who = { subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@transcript.test`, session: randomUUID() };
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

  async function join(name: string, role: 'admin' | 'member' | 'viewer') {
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

    const created = await rpc('org/create', 'owner', { name: `Transcript Test Org ${randomUUID().slice(0, 6)}`, idempotencyKey: randomUUID() }, null);
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

  const SAY = 'Chúng ta chốt giá gói Pro là 1.200.000 đồng, anh Nam gửi báo giá cho khách vào thứ Sáu.';
  const segment = (start: number, end: number, text: string, speakerLabel = 'Người nói 1') => ({ startSeconds: start, endSeconds: end, speakerLabel, text });

  async function newMeeting(title: string, visibility: 'attendees' | 'org' = 'attendees') {
    const created = await rpc('meetings/create', 'recorder', {
      title,
      language: 'vi',
      visibility,
      keepVideo: false,
      consentMethod: 'told_at_start',
      readerUserIds: [userIds.get('attendee')!],
    });
    expect(created.status).toBe(200);
    return String(created.body.meetingId);
  }
  const rows = (meetingId: string) =>
    admin(async (c) => (await c.query('SELECT id, stage, text, speaker_label, corrected FROM crove_meetings.transcript_segment WHERE meeting_id = $1 ORDER BY start_seconds, id', [meetingId])).rows as Array<{ id: string; stage: string; text: string; speaker_label: string; corrected: boolean }>);
  const auditOf = (command: string) =>
    admin(async (c) => (await c.query('SELECT detail, target_id FROM crove_kernel.audit_event WHERE org_id = $1 AND command = $2 ORDER BY occurred_at', [orgId, command])).rows as Array<{ detail: Record<string, unknown>; target_id: string | null }>);
  const get = (name: string, meetingId: string) => rpc('meetings/transcript/get', name, { meetingId });
  const storeDraft = (name: string, meetingId: string, segments: unknown[]) => rpc('meetings/transcript/draftStore', name, { meetingId, segments });

  it('lets the recorder store and read a draft in time order, and nobody else reads it', async () => {
    const meetingId = await newMeeting('Họp giá gói Pro');
    expect((await get('recorder', meetingId)).body).toMatchObject({ meetingId, isRecorder: true, stage: 'none', segments: [] });
    const stored = await storeDraft('recorder', meetingId, [segment(20, 30, 'Hai', 'Lan'), segment(0, 10, SAY), segment(10, 20, 'Ba')]);
    expect(stored.status).toBe(200);
    expect(stored.body).toMatchObject({ meetingId, stored: 3 });
    const mine = (await get('recorder', meetingId)).body as { stage: string; isRecorder: boolean; segments: Array<{ startSeconds: number; text: string; stage: string; speakerLabel: string }> };
    expect(mine.stage).toBe('draft');
    expect(mine.segments.map((s) => [s.startSeconds, s.text, s.stage])).toEqual([[0, SAY, 'draft'], [10, 'Ba', 'draft'], [20, 'Hai', 'draft']]);
    expect(mine.segments[2]!.speakerLabel).toBe('Lan');
    // The attendee reads the meeting but no draft; owner, another member and the viewer cannot even open an attendees-only meeting.
    expect((await get('attendee', meetingId)).body).toMatchObject({ stage: 'none', isRecorder: false, segments: [] });
    for (const name of ['owner', 'otherMember', 'viewer']) {
      const r = await get(name, meetingId);
      expect(r.status, name).toBeGreaterThanOrEqual(400);
      expect(JSON.stringify(r.body), name).not.toContain('chốt giá');
    }
  });

  it('shows no draft line to the owner, an admin or another member of an org-wide meeting either', async () => {
    await join('boss', 'admin');
    const meetingId = await newMeeting('Họp toàn công ty', 'org');
    await storeDraft('recorder', meetingId, [segment(0, 10, 'chỉ người ghi thấy bản nháp này')]);
    // The meeting itself is open to every member of the org; its draft is not.
    for (const name of ['owner', 'boss', 'otherMember', 'attendee']) {
      const meeting = await rpc('meetings/get', name, { meetingId });
      expect(meeting.status, `${name} opens the org-wide meeting`).toBe(200);
      const transcript = await get(name, meetingId);
      expect(transcript.status, name).toBe(200);
      expect(transcript.body, name).toMatchObject({ isRecorder: false, stage: 'none', segments: [] });
      expect(JSON.stringify(transcript.body), name).not.toContain('chỉ người ghi');
    }
    for (const name of ['owner', 'boss', 'otherMember', 'attendee']) {
      expect((await storeDraft(name, meetingId, [segment(0, 5, 'giả mạo')])).status, name).toBeGreaterThanOrEqual(400);
    }
    expect((await rows(meetingId)).map((r) => r.text)).toEqual(['chỉ người ghi thấy bản nháp này']);
  });

  it('refuses an agent or the system context at both commands', async () => {
    const meetingId = await newMeeting('Họp không cho máy ghi');
    await storeDraft('recorder', meetingId, [segment(0, 5, 'của người ghi')]);
    const [only] = await rows(meetingId);
    const actors = [
      { type: 'system' as const, component: 'kernel.agent' },
      { type: 'agent' as const, agentId: randomUUID(), runId: randomUUID() },
    ];
    for (const actor of actors) {
      await expect(runtime.execute('meetings.transcript.draft_store', { meetingId, segments: [segment(0, 5, 'máy viết')] }, { actor: actor as never, orgId }), actor.type).rejects.toThrow();
      await expect(runtime.execute('meetings.transcript.correct', { segmentId: only!.id, text: 'máy sửa' }, { actor: actor as never, orgId }), actor.type).rejects.toThrow();
    }
    expect((await rows(meetingId)).map((r) => [r.text, r.corrected])).toEqual([['của người ghi', false]]);
  });

  it('refuses to store or correct a transcript for anyone but the recorder', async () => {
    const meetingId = await newMeeting('Họp nội bộ');
    for (const name of ['attendee', 'otherMember', 'owner', 'viewer']) {
      const r = await storeDraft(name, meetingId, [segment(0, 5, 'giả mạo')]);
      expect(r.status, name).toBeGreaterThanOrEqual(400);
    }
    expect(await rows(meetingId)).toEqual([]);
    expect((await storeDraft('recorder', meetingId, [segment(0, 5, 'một')])).status).toBe(200);
    const [only] = await rows(meetingId);
    for (const name of ['attendee', 'otherMember', 'owner', 'viewer']) {
      const r = await rpc('meetings/transcript/correct', name, { segmentId: only!.id, text: 'bị sửa' });
      expect(r.status, name).toBeGreaterThanOrEqual(400);
    }
    expect((await rows(meetingId))[0]!.text).toBe('một');
    expect((await rpc('meetings/transcript/correct', 'recorder', { segmentId: randomUUID(), text: 'x' })).status).toBe(404);
  });

  it('lets the recorder correct a line, and a new run replaces the draft', async () => {
    const meetingId = await newMeeting('Họp sửa bản ghi');
    await storeDraft('recorder', meetingId, [segment(0, 10, 'xin chao moi nguoi'), segment(10, 20, 'tam biet')]);
    const [first, second] = await rows(meetingId);
    const fixed = await rpc('meetings/transcript/correct', 'recorder', { segmentId: first!.id, text: 'Xin chào mọi người', speakerLabel: 'Anh Nam' });
    expect(fixed.status).toBe(200);
    expect(fixed.body).toMatchObject({ segmentId: first!.id, corrected: true });
    const after = await rows(meetingId);
    expect(after[0]).toMatchObject({ text: 'Xin chào mọi người', speaker_label: 'Anh Nam', corrected: true });
    expect(after[1]).toMatchObject({ id: second!.id, text: 'tam biet', corrected: false });
    expect((await rpc('meetings/transcript/correct', 'recorder', { segmentId: first!.id })).status).toBe(400);
    // A new transcription run replaces the earlier draft, corrections included.
    expect((await storeDraft('recorder', meetingId, [segment(0, 30, 'bản mới')])).body).toMatchObject({ stored: 1 });
    expect((await rows(meetingId)).map((r) => [r.text, r.corrected])).toEqual([['bản mới', false]]);
  });

  it('shows a reader of the meeting published segments only, and lets nobody edit them', async () => {
    const meetingId = await newMeeting('Họp công bố');
    await storeDraft('recorder', meetingId, [segment(0, 10, 'nháp một')]);
    await admin((c) =>
      c.query(`INSERT INTO crove_meetings.transcript_segment (org_id, meeting_id, start_seconds, end_seconds, speaker_label, text, stage) VALUES ($1, $2, 100, 110, 'Người nói 1', 'đã công bố', 'published')`, [orgId, meetingId]),
    );
    const attendee = (await get('attendee', meetingId)).body as { stage: string; segments: Array<{ text: string; stage: string }> };
    expect(attendee.stage).toBe('published');
    expect(attendee.segments.map((s) => [s.text, s.stage])).toEqual([['đã công bố', 'published']]);
    const recorder = (await get('recorder', meetingId)).body as { segments: Array<{ stage: string }> };
    expect(recorder.segments.map((s) => s.stage)).toEqual(['draft', 'published']);
    const published = (await rows(meetingId)).find((r) => r.stage === 'published')!;
    expect((await rpc('meetings/transcript/correct', 'recorder', { segmentId: published.id, text: 'sửa' })).status).toBe(404);
    // The recorder's re-run replaces the draft and leaves the published rows.
    await storeDraft('recorder', meetingId, [segment(0, 10, 'nháp hai')]);
    expect((await rows(meetingId)).map((r) => [r.stage, r.text])).toEqual([['draft', 'nháp hai'], ['published', 'đã công bố']]);
  });

  it('refuses malformed segments', async () => {
    const meetingId = await newMeeting('Họp lỗi');
    for (const bad of [segment(10, 5, 'ngược'), segment(0, 5, ''), segment(-1, 5, 'âm'), segment(0, 5, 'x'.repeat(4001)), { startSeconds: 0, endSeconds: 1, speakerLabel: 'A', text: 'x', stage: 'published' }]) {
      const r = await storeDraft('recorder', meetingId, [bad]);
      expect(r.status, JSON.stringify(bad).slice(0, 60)).toBeGreaterThanOrEqual(400);
    }
    expect(await rows(meetingId)).toEqual([]);
  });

  it('writes ids and counts to the audit, never the text, and audits each read', async () => {
    const meetingId = await newMeeting('Họp kiểm toán');
    await storeDraft('recorder', meetingId, [segment(0, 10, SAY, 'Bà Hạnh')]);
    const [only] = await rows(meetingId);
    await rpc('meetings/transcript/correct', 'recorder', { segmentId: only!.id, text: 'Văn bản đã sửa riêng tư' });
    await get('recorder', meetingId);
    const everything = JSON.stringify(await admin(async (c) => (await c.query(`SELECT detail, target_id, command FROM crove_kernel.audit_event WHERE org_id = $1 AND command LIKE 'meetings.transcript.%'`, [orgId])).rows));
    expect(everything).toContain('meetings.transcript.draft_store');
    expect(everything).toContain('meetings.transcript.correct');
    expect(everything).toContain('meetings.transcript.get');
    for (const secret of ['chốt giá', 'Bà Hạnh', 'Văn bản đã sửa', '1.200.000']) expect(everything).not.toContain(secret);
    const stored = (await auditOf('meetings.transcript.draft_store')).find((a) => a.detail.meetingId === meetingId);
    expect(stored?.detail).toMatchObject({ meetingId, stored: 1 });
    const corrected = (await auditOf('meetings.transcript.correct')).find((a) => a.detail.segmentId === only!.id);
    expect(corrected?.detail).toMatchObject({ segmentId: only!.id, meetingId, textChanged: true, labelChanged: false });
  });

  it('goes with its meeting when the recorder deletes it', async () => {
    const meetingId = await newMeeting('Họp bị xóa');
    await storeDraft('recorder', meetingId, [segment(0, 10, 'sẽ biến mất'), segment(10, 20, 'cùng cuộc họp')]);
    await admin((c) => c.query(`INSERT INTO crove_meetings.transcript_segment (org_id, meeting_id, start_seconds, end_seconds, text, stage) VALUES ($1, $2, 30, 40, 'đã công bố', 'published')`, [orgId, meetingId]));
    expect(await rows(meetingId)).toHaveLength(3);
    const gone = await rpc('meetings/delete', 'recorder', { meetingId });
    expect(gone.status).toBe(200);
    expect(await rows(meetingId)).toEqual([]);
  });
});

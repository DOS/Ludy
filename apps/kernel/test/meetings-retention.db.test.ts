// SPDX-License-Identifier: AGPL-3.0-only
// Retention and shredding of meeting audio, video and text on PostgreSQL (issue #2579, ADR-0047 point 7): the three settings stamped on a meeting, the nightly
// job that shreds audio and video keys and deletes text, the sweep of ciphertext objects and file rows, the shred references in the archive store and their
// replay after a restore, and the org purge and export.
import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { kernelCommands, kernelQueries } from '@crove/kernel';
import { BlobNotFoundError, Runtime, sha256Hex, type BlobStore, type CredentialBroker } from '@crove/kernel-runtime';
import { financeCommands, financeQueries } from '@crove/mod-finance';
import { dayAfter, meetingsCommands, meetingsQueries, retentionDates } from '@crove/mod-meetings';
import { createAuthenticator } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp, type HttpDeps } from '../src/http.ts';
import { SHRED_REF_ALERT_AFTER, createShredRefSync, replayShreds, runMeetingsRetention, shredRefKey, sweepMeetingMedia, syncShredRefs } from '../src/meetings-retention.ts';
import { orgPurgeCommand, purgeOrg } from '../src/org-purge.ts';
import { createSessionStatusSource } from '../src/sessions.ts';
import { LocalArchiveStore } from '../src/worm.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const SECRET = 'test-only-meetings-retention-secret-0123456789';
const ISSUER = 'crove-auth-meetings-retention';
const suite = ADMIN ? describe : describe.skip;
const SYSTEM = { type: 'system' as const, component: 'test.meetings-retention' };
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

suite('meeting retention and shredding on PostgreSQL (#2579)', () => {
  const dbName = `crove_test_meetings_retention_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const archiveDir = mkdtempSync(join(tmpdir(), 'crove-shred-refs-'));
  const archive = new LocalArchiveStore(archiveDir);
  let adminUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let store: MemoryStore;
  let app: ReturnType<typeof createHttpApp>;
  let worker: Runtime;
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
      who = { subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@retention.test`, session: randomUUID() };
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

  async function withWorker<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const url = new URL(adminUrl);
    url.username = 'crove_worker';
    url.password = 'test-worker-pw';
    const c = new pg.Client({ connectionString: url.toString() });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }

  const yesterday = "(pg_catalog.timezone('Asia/Ho_Chi_Minh', pg_catalog.now()))::date - 1";
  const retention = () => runMeetingsRetention({ runtime: worker, workerDb, log: quiet });
  const sweep = () => sweepMeetingMedia({ runtime: worker, workerDb, store, log: quiet });
  const meetingRow = async (id: string) => (await rows<{ audio: string; text: string | null }>('SELECT audio_retention_date::text AS audio, text_retention_date::text AS text FROM crove_meetings.meeting WHERE id = $1', [id]))[0];

  beforeAll(async () => {
    store = new MemoryStore();
    const broker = {
      keyId: 'k1-retention-test',
      keyIds: ['k1-retention-test'],
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
    worker = new Runtime(workerDb, { manifests: TEST_MANIFESTS }).register(registry).register({ commands: [orgPurgeCommand({ store })] });
    const deps: HttpDeps = { config, runtime, store, broker, authenticate: createAuthenticator(config, db), pool, aiEnabled: false };
    app = createHttpApp(deps);
    const created = await rpc('org/create', 'owner', { name: `Retention Org ${randomUUID().slice(0, 6)}`, idempotencyKey: randomUUID() }, null);
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
    rmSync(archiveDir, { recursive: true, force: true });
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('computes the three dates from the settings: video never past audio, 0 for audio is 7 days, 0 for text is until deleted', () => {
    const at = new Date('2026-11-07T10:00:00Z');
    expect(retentionDates(at, { audioRetentionDays: 30, videoRetentionDays: 7, textRetentionDays: 365 })).toEqual({ audio: '2026-12-07', video: '2026-11-14', text: '2027-11-07' });
    expect(retentionDates(at, { audioRetentionDays: 0, videoRetentionDays: 7, textRetentionDays: 0 })).toEqual({ audio: '2026-11-14', video: '2026-11-14', text: null });
    expect(retentionDates(at, { audioRetentionDays: 90, videoRetentionDays: 30, textRetentionDays: 90 }).video).toBe('2026-12-07');
    // The Vietnam calendar day: 20:00 UTC is already the next morning there.
    expect(dayAfter(new Date('2026-11-07T20:00:00Z'), 0)).toBe('2026-11-08');
  });

  it('stamps the org settings on a meeting when it is recorded, and a later change leaves earlier meetings alone', async () => {
    const defaults = await rpc('meetings/settings/get', 'recorder', {});
    expect(defaults.body).toEqual({ audioRetentionDays: 30, videoRetentionDays: 7, textRetentionDays: 365 });
    const first = await createMeeting('recorder', { keepVideo: true });
    const now = new Date();
    expect(await meetingRow(first)).toEqual({ audio: dayAfter(now, 30), text: dayAfter(now, 365) });

    // Only an owner or admin changes them; a video cannot outlast the audio.
    expect((await rpc('meetings/settings/set', 'recorder', { audioRetentionDays: 7, videoRetentionDays: 7, textRetentionDays: 90 })).status).toBe(403);
    expect((await rpc('meetings/settings/set', 'owner', { audioRetentionDays: 7, videoRetentionDays: 30, textRetentionDays: 90 })).status).toBeGreaterThanOrEqual(400);
    expect((await rpc('meetings/settings/set', 'owner', { audioRetentionDays: 14, videoRetentionDays: 7, textRetentionDays: 90 })).status).toBeGreaterThanOrEqual(400);
    const set = await rpc('meetings/settings/set', 'owner', { audioRetentionDays: 7, videoRetentionDays: 7, textRetentionDays: 90 });
    expect(set.status).toBe(200);
    expect((await rpc('meetings/settings/get', 'attendee', {})).body).toEqual({ audioRetentionDays: 7, videoRetentionDays: 7, textRetentionDays: 90 });

    const second = await createMeeting('recorder', { keepVideo: true });
    expect(await meetingRow(second)).toEqual({ audio: dayAfter(now, 7), text: dayAfter(now, 90) });
    expect(await meetingRow(first)).toEqual({ audio: dayAfter(now, 30), text: dayAfter(now, 365) });
    await upload('recorder', second, 'video', 'v');
    expect((await rows<{ d: string }>('SELECT video_retention_date::text AS d FROM crove_meetings.meeting_video WHERE meeting_id = $1', [second]))[0]!.d).toBe(dayAfter(now, 7));

    // "Until deleted" leaves no text date; the audio's 0 is the 7 days of a meeting with no transcript.
    expect((await rpc('meetings/settings/set', 'owner', { audioRetentionDays: 0, videoRetentionDays: 7, textRetentionDays: 0 })).status).toBe(200);
    const third = await createMeeting('recorder');
    expect(await meetingRow(third)).toEqual({ audio: dayAfter(now, 7), text: null });
    expect((await rpc('meetings/get', 'recorder', { meetingId: third })).body.textRetentionDate).toBeNull();
    await rpc('meetings/settings/set', 'owner', { audioRetentionDays: 30, videoRetentionDays: 7, textRetentionDays: 365 });

    // The audit row holds the periods and no title.
    const audits = await rows<{ detail: Record<string, unknown> }>("SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'meetings.settings.set' AND outcome = 'ok' ORDER BY occurred_at", [orgId]);
    expect(audits.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(audits)).not.toContain('Họp tuần');
  });

  it('keeps the recorder and every login role from writing the retention dates or the settings directly', async () => {
    const grants = await rows<{ role: string; col: string }>(
      `SELECT r.rolname AS role, c AS col FROM pg_roles r, unnest(ARRAY['audio_retention_date', 'text_retention_date']) c
        WHERE r.rolname IN ('crove_tenant', 'crove_app', 'crove_worker') AND has_column_privilege(r.oid, 'crove_meetings.meeting', c, 'UPDATE')`,
    );
    expect(grants).toEqual([]);
    // The tenant row's guard refuses a change of a setting from any context but an owner's or admin's: here the worker's system context of the org, which
    // reaches the row but is neither (a member's own context is refused by the same guard).
    const refused = await withWorker(async (c) => {
      await c.query('BEGIN');
      try {
        await c.query('SELECT crove_kernel.enter_system_context($1)', [orgId]);
        await c.query('UPDATE crove_kernel.tenant SET meeting_text_retention_days = 90 WHERE org_id = $1', [orgId]);
        return 'changed';
      } catch (error) {
        return (error as Error).message;
      } finally {
        await c.query('ROLLBACK');
      }
    });
    expect(refused).toMatch(/MEETING_SETTINGS_FORBIDDEN/);
    expect((await rpc('meetings/settings/get', 'owner', {})).body.textRetentionDays).toBe(365);
  });

  it('shreds the audio key at its date: the audio does not decrypt, its rows go, the sweep removes the object and the file row, the video and the text stay', async () => {
    const meetingId = await createMeeting('recorder', { title: 'Audio ends first', keepVideo: true, readerUserIds: [userIds.get('attendee')] });
    const audio = await upload('recorder', meetingId, 'audio', 'a');
    const video = await upload('recorder', meetingId, 'video', 'v');
    expect(Buffer.from(await (await play('attendee', meetingId, 'audio')).arrayBuffer()).equals(audio)).toBe(true);
    const audioFile = (await rows<{ file_id: string }>('SELECT file_id FROM crove_meetings.audio_segment WHERE meeting_id = $1', [meetingId]))[0]!.file_id;
    const audioKey = (await rows<{ storage_key: string }>('SELECT storage_key FROM crove_kernel.file WHERE id = $1', [audioFile]))[0]!.storage_key;
    expect(store.storage.has(audioKey)).toBe(true);

    // Not due: nothing happens.
    expect((await retention()).shredded).toEqual({ audio: 0, video: 0, text: 0, draft: 0 });
    expect(await count('SELECT 1 FROM crove_meetings.media_key WHERE meeting_id = $1', [meetingId])).toBe(2);

    await rows(`UPDATE crove_meetings.meeting SET audio_retention_date = ${yesterday} WHERE id = $1`, [meetingId]);
    const run = await retention();
    expect(run.shredded.audio).toBeGreaterThanOrEqual(1);
    expect(run.failed).toBe(0);
    expect(await count("SELECT 1 FROM crove_meetings.media_key WHERE meeting_id = $1 AND kind = 'audio'", [meetingId])).toBe(0);
    expect(await count("SELECT 1 FROM crove_meetings.media_key WHERE meeting_id = $1 AND kind = 'video'", [meetingId])).toBe(1);
    expect(await count('SELECT 1 FROM crove_meetings.audio_segment WHERE meeting_id = $1', [meetingId])).toBe(0);
    // The audio no longer decrypts, for its recorder and its attendee alike; the meeting and its video are still there.
    for (const who of ['recorder', 'attendee']) expect((await play(who, meetingId, 'audio')).status, who).toBe(404);
    expect(Buffer.from(await (await play('attendee', meetingId, 'video')).arrayBuffer()).equals(video)).toBe(true);
    expect((await rpc('meetings/get', 'recorder', { meetingId })).body).toMatchObject({ hasAudio: false, hasVideo: true });

    // A meeting past its audio period takes no new audio (it would be shredded at once), and the refused upload leaves no object behind.
    const objectsBefore = store.storage.size;
    const form = new FormData();
    form.append('kind', 'audio');
    form.append('file', new Blob([Buffer.concat([OGG, Buffer.alloc(40, 1)])], { type: 'audio/ogg' }), 'again.ogg');
    const again = await app.request(`/api/meetings/${meetingId}/media`, { method: 'POST', headers: { authorization: `Bearer ${await token('recorder')}`, 'x-crove-org': slug }, body: form });
    expect(again.status).toBe(409);
    expect(store.storage.size).toBe(objectsBefore);
    expect(await count('SELECT 1 FROM crove_meetings.media_key WHERE meeting_id = $1 AND kind = $2', [meetingId, 'audio'])).toBe(0);

    // The object and the file row are still there until the sweep: ciphertext no key opens.
    expect(await count('SELECT 1 FROM crove_kernel.file WHERE id = $1', [audioFile])).toBe(1);
    const swept = await sweep();
    expect(swept.failed).toBe(0);
    expect(store.storage.has(audioKey)).toBe(false);
    expect(await count('SELECT 1 FROM crove_kernel.file WHERE id = $1', [audioFile])).toBe(0);

    // Run twice, nothing more to do.
    expect((await retention()).shredded.audio).toBe(0);
    expect((await sweep()).deleted).toBe(0);

    // The video has its own date.
    await rows(`UPDATE crove_meetings.meeting_video SET video_retention_date = ${yesterday} WHERE meeting_id = $1`, [meetingId]);
    expect((await retention()).shredded.video).toBeGreaterThanOrEqual(1);
    expect((await play('recorder', meetingId, 'video')).status).toBe(404);
    expect(await count('SELECT 1 FROM crove_meetings.media_key WHERE meeting_id = $1', [meetingId])).toBe(0);
    await sweep();
    expect(await count("SELECT 1 FROM crove_kernel.file WHERE org_id = $1 AND filename LIKE $2", [orgId, `meeting-${meetingId}.%`])).toBe(0);
    expect(await count('SELECT 1 FROM crove_meetings.meeting WHERE id = $1', [meetingId])).toBe(1);
  });

  describe('drafts the recorder never published (#2580, M6 part C)', () => {
    const DAYS = (n: number) => `now() - interval '${n} days'`;
    async function seedDrafts(meetingId: string, age: number, text: string, org = orgId) {
      await rows(`INSERT INTO crove_meetings.meeting_result (org_id, meeting_id, summary, feature, stage, created_at, updated_at) VALUES ($1, $2, $3, 'manual', 'draft', ${DAYS(age)}, now())`, [org, meetingId, text]);
      await rows(`INSERT INTO crove_meetings.action_item (org_id, meeting_id, title, stage, created_at, updated_at) VALUES ($1, $2, $3, 'draft', ${DAYS(age)}, now())`, [org, meetingId, text]);
      await rows(`INSERT INTO crove_meetings.transcript_segment (org_id, meeting_id, start_seconds, end_seconds, text, stage, created_at, updated_at) VALUES ($1, $2, 0, 5, $3, 'draft', ${DAYS(age)}, now())`, [org, meetingId, text]);
    }
    const left = async (meetingId: string, stage: string) =>
      (await Promise.all(['meeting_result', 'action_item', 'transcript_segment'].map((t) => count(`SELECT 1 FROM crove_meetings.${t} WHERE meeting_id = $1 AND stage = '${stage}'`, [meetingId])))).reduce((a, b) => a + b, 0);

    it('deletes a draft past 30 days, counted from its creation whatever its updated_at says, and keeps one at 29 days, a published row and another meeting', async () => {
      const old = await createMeeting('recorder', { title: 'Nháp cũ' });
      const young = await createMeeting('recorder', { title: 'Nháp mới' });
      const mixed = await createMeeting('recorder', { title: 'Đã chia sẻ' });
      await seedDrafts(old, 31, 'BẢN NHÁP BÍ MẬT');
      await seedDrafts(young, 29, 'bản nháp mới');
      await seedDrafts(mixed, 31, 'bản nháp cũ của họp đã chia sẻ');
      await rows(`INSERT INTO crove_meetings.meeting_result (org_id, meeting_id, summary, feature, stage, created_at) VALUES ($1, $2, 'đã chia sẻ', 'manual', 'published', ${DAYS(60)})`, [orgId, mixed]);
      await rows(`INSERT INTO crove_meetings.action_item (org_id, meeting_id, title, stage, created_at) VALUES ($1, $2, 'việc đã chia sẻ', 'published', ${DAYS(60)})`, [orgId, mixed]);
      await rows(`INSERT INTO crove_meetings.transcript_segment (org_id, meeting_id, start_seconds, end_seconds, text, stage, created_at) VALUES ($1, $2, 0, 5, 'dòng đã chia sẻ', 'published', ${DAYS(60)})`, [orgId, mixed]);

      const run = await retention();
      expect(run.shredded.draft).toBeGreaterThanOrEqual(2);
      expect(await left(old, 'draft')).toBe(0);
      expect(await left(young, 'draft')).toBe(3);
      expect(await left(mixed, 'draft')).toBe(0);
      expect(await left(mixed, 'published')).toBe(3);
      expect(await count('SELECT 1 FROM crove_meetings.meeting WHERE id = ANY($1)', [[old, young, mixed]])).toBe(3);
      // The audit row names the meeting by id with a kind and a count, never the text.
      const audit = await rows<{ detail: unknown }>("SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'meetings.retention.shred' AND target_id = $2", [orgId, old]);
      expect(audit).toHaveLength(1);
      expect(JSON.stringify(audit)).toContain('draft');
      expect(JSON.stringify(audit)).not.toContain('BÍ MẬT');
      // A second run finds nothing more.
      expect((await retention()).shredded.draft).toBe(0);
    });

    it('does not delete a draft the recorder published after the scan and before the purge', async () => {
      const meetingId = await createMeeting('recorder', { title: 'Chia sẻ đúng lúc' });
      await seedDrafts(meetingId, 40, 'sắp chia sẻ');
      const due = await sql<{ meeting_id: string }>`SELECT meeting_id FROM crove_meetings.meeting_drafts_due(1000::int)`.execute(workerDb);
      expect(due.rows.map((r) => r.meeting_id)).toContain(meetingId);
      for (const t of ['meeting_result', 'action_item', 'transcript_segment']) await rows(`UPDATE crove_meetings.${t} SET stage = 'published' WHERE meeting_id = $1`, [meetingId]);
      const out = await worker.execute<{ applied: boolean }>('meetings.retention.shred', { meetingId, kind: 'draft' }, { actor: SYSTEM, orgId });
      expect(out.applied).toBe(false);
      expect(await left(meetingId, 'published')).toBe(3);
    });

    it('does not delete a draft whose publish commits while the purge waits for it', async () => {
      const meetingId = await createMeeting('recorder', { title: 'Chia sẻ trong lúc xóa' });
      await seedDrafts(meetingId, 40, 'đang chia sẻ');
      const publisher = new pg.Client({ connectionString: adminUrl });
      await publisher.connect();
      try {
        await publisher.query('BEGIN');
        for (const t of ['meeting_result', 'action_item', 'transcript_segment']) await publisher.query(`UPDATE crove_meetings.${t} SET stage = 'published' WHERE meeting_id = $1`, [meetingId]);
        // The purge starts while the publish holds the rows, so it waits on them; the publish then commits.
        const purge = worker.execute<{ applied: boolean }>('meetings.retention.shred', { meetingId, kind: 'draft' }, { actor: SYSTEM, orgId });
        // The purge is waiting on the publish's row lock (seen in pg_stat_activity), not merely slow.
        let waiting = false;
        for (let i = 0; i < 100 && !waiting; i += 1) {
          waiting = (await count("SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%meeting_draft_purge%'")) > 0;
          if (!waiting) await new Promise((resolve) => setTimeout(resolve, 50));
        }
        expect(waiting).toBe(true);
        await publisher.query('COMMIT');
        expect((await purge).applied).toBe(false);
      } finally {
        await publisher.end();
      }
      expect(await left(meetingId, 'published')).toBe(3);
      expect(await left(meetingId, 'draft')).toBe(0);
    });

    it('is the worker\'s alone: refused to the API login, to the worker with no context, and to a context of another org', async () => {
      const meetingId = await createMeeting('recorder', { title: 'Chỉ worker' });
      for (const call of ['SELECT * FROM crove_meetings.meeting_drafts_due(10)', 'SELECT crove_meetings.meeting_draft_purge(gen_random_uuid(), gen_random_uuid())']) {
        const asApp = await admin(async (c) => {
          await c.query('SET ROLE crove_app');
          return c.query(call).then(() => 'ran').catch((e: Error) => e.message);
        });
        expect(asApp, call).toMatch(/permission denied/);
      }
      expect(await withWorker((c) => c.query('SELECT crove_meetings.meeting_draft_purge($1, $2)', [orgId, meetingId]).then(() => 'ran').catch((e: Error) => e.message))).toMatch(/MEETINGS_WORKER_ONLY/);
      // A system context of another org than the one named is refused, and the scan refuses any context.
      const mismatched = await withWorker(async (c) => {
        await c.query('BEGIN');
        try {
          await c.query('SELECT crove_kernel.enter_system_context($1)', [orgId]);
          return await c.query('SELECT crove_meetings.meeting_draft_purge(gen_random_uuid(), $1)', [meetingId]).then(() => 'ran').catch((e: Error) => e.message);
        } finally {
          await c.query('ROLLBACK');
        }
      });
      expect(mismatched).toMatch(/MEETINGS_WORKER_ONLY/);
      const scan = await withWorker(async (c) => {
        await c.query('BEGIN');
        try {
          await c.query('SELECT crove_kernel.enter_system_context($1)', [orgId]);
          return await c.query('SELECT * FROM crove_meetings.meeting_drafts_due(10)').then(() => 'ran').catch((e: Error) => e.message);
        } finally {
          await c.query('ROLLBACK');
        }
      });
      expect(scan).toMatch(/MEETINGS_WORKER_ONLY/);
    });

    it('purges each org in its own context and never reaches across: the other org\'s expired draft is deleted by its own run, and a purge in one org leaves the other\'s rows', async () => {
      const created = await rpc('org/create', 'purgeOwner2', { name: `Draft Org ${randomUUID().slice(0, 6)}`, idempotencyKey: randomUUID() }, null);
      expect(created.status).toBe(200);
      const otherSlug = String(created.body.slug);
      const otherOrg = String(created.body.orgId);
      userIds.set('purgeOwner2', (await rows<{ id: string }>('SELECT id FROM crove_kernel.user_account WHERE email = $1', [accounts.get('purgeOwner2')?.email]))[0]!.id);
      const mine = await createMeeting('recorder', { title: 'Của tôi' });
      const theirs = await createMeeting('purgeOwner2', { title: 'Của họ' }, otherSlug);
      await seedDrafts(mine, 40, 'nháp của tôi');
      await seedDrafts(theirs, 40, 'nháp của họ', otherOrg);
      // This org's context with the other org's meeting id deletes nothing.
      const crossed = await worker.execute<{ applied: boolean }>('meetings.retention.shred', { meetingId: theirs, kind: 'draft' }, { actor: SYSTEM, orgId });
      expect(crossed.applied).toBe(false);
      expect(await left(theirs, 'draft')).toBe(3);
      // The run purges both, each in its own org.
      await retention();
      expect(await left(mine, 'draft')).toBe(0);
      expect(await left(theirs, 'draft')).toBe(0);
    });

    it('does not replace the shared summary with nothing when the draft is purged while a publish is waiting: the old summary stays and nothing is claimed shared', async () => {
      const meetingId = await createMeeting('recorder', { title: 'Chia sẻ lúc nháp hết hạn' });
      await rows(`INSERT INTO crove_meetings.meeting_result (org_id, meeting_id, summary, feature, stage, created_at) VALUES ($1, $2, 'bản đã chia sẻ trước', 'manual', 'published', ${DAYS(50)})`, [orgId, meetingId]);
      await rows(`INSERT INTO crove_meetings.meeting_result (org_id, meeting_id, summary, feature, stage, created_at) VALUES ($1, $2, 'bản nháp hết hạn', 'manual', 'draft', ${DAYS(40)})`, [orgId, meetingId]);
      const purger = new pg.Client({ connectionString: adminUrl });
      await purger.connect();
      try {
        // The purge has deleted the draft but not yet committed: the publish's lock on it waits for that.
        await purger.query('BEGIN');
        await purger.query("DELETE FROM crove_meetings.meeting_result WHERE meeting_id = $1 AND stage = 'draft'", [meetingId]);
        const publishing = rpc('meetings/results/publish', 'recorder', { meetingId, confirmed: true });
        let waiting = false;
        for (let i = 0; i < 100 && !waiting; i += 1) {
          waiting = (await count("SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%meeting_result%' AND query ILIKE '%for update%'")) > 0;
          if (!waiting) await new Promise((resolve) => setTimeout(resolve, 50));
        }
        expect(waiting).toBe(true);
        await purger.query('COMMIT');
        const res = await publishing;
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('NOTHING_TO_PUBLISH');
      } finally {
        await purger.end();
      }
      expect(await count("SELECT 1 FROM crove_meetings.meeting_result WHERE meeting_id = $1 AND stage = 'published' AND summary = 'bản đã chia sẻ trước'", [meetingId])).toBe(1);
    });
  });

  it('deletes the meeting at its text date: no row, no key, no object, no file row of it is left', async () => {
    const meetingId = await createMeeting('recorder', { title: 'Text ends', keepVideo: true, readerUserIds: [userIds.get('attendee')] });
    await upload('recorder', meetingId, 'audio', 'a');
    await upload('recorder', meetingId, 'video', 'v');
    const fileRows = await rows<{ storage_key: string }>("SELECT storage_key FROM crove_kernel.file WHERE org_id = $1 AND filename LIKE $2", [orgId, `meeting-${meetingId}.%`]);
    expect(fileRows).toHaveLength(2);
    const tables = ['meeting', 'meeting_reader', 'audio_segment', 'meeting_video', 'media_key'];
    const left = async () => (await Promise.all(tables.map((t) => count(`SELECT 1 FROM crove_meetings.${t} WHERE ${t === 'meeting' ? 'id' : 'meeting_id'} = $1`, [meetingId])))).reduce((a, b) => a + b, 0);
    expect(await left()).toBeGreaterThan(0);

    await rows(`UPDATE crove_meetings.meeting SET text_retention_date = ${yesterday} WHERE id = $1`, [meetingId]);
    const run = await retention();
    expect(run.shredded.text).toBeGreaterThanOrEqual(1);
    expect(await left()).toBe(0);
    // Both keys went with the text, so even before the sweep nothing opens.
    expect((await play('recorder', meetingId, 'audio')).status).toBeGreaterThanOrEqual(400);
    await sweep();
    for (const f of fileRows) expect(store.storage.has(f.storage_key)).toBe(false);
    expect(await count("SELECT 1 FROM crove_kernel.file WHERE org_id = $1 AND filename LIKE $2", [orgId, `meeting-${meetingId}.%`])).toBe(0);
    // The audit trail names the meeting by id, with a count and a kind, never its title.
    const audit = await rows<{ detail: unknown }>("SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'meetings.retention.shred' AND target_id = $2", [orgId, meetingId]);
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toContain('Text ends');
  });

  it('stops a playback that is streaming when the retention shreds its audio, and when the segment it reads is replaced', async () => {
    const long = async (title: string) => {
      const meetingId = await createMeeting('recorder', { title });
      // Over two 4 MiB stream windows, so each window after the first asks again whether the meeting and its file are the same.
      const bytes = Buffer.concat([OGG, Buffer.alloc(9 * 1024 * 1024, 0x61)]);
      const form = new FormData();
      form.append('kind', 'audio');
      form.append('file', new Blob([bytes], { type: 'audio/ogg' }), 'long.ogg');
      const up = await app.request(`/api/meetings/${meetingId}/media`, { method: 'POST', headers: { authorization: `Bearer ${await token('recorder')}`, 'x-crove-org': slug }, body: form });
      expect(up.status).toBe(200);
      const res = await play('recorder', meetingId, 'audio');
      expect(res.status).toBe(200);
      return { meetingId, res, size: bytes.length };
    };
    const drain = async (res: Response) => {
      const reader = res.body!.getReader();
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
      return { received, failed };
    };

    // The retention shreds the audio while the first window is out: the stream does not complete.
    const shredded = await long('Shredded while playing');
    await rows(`UPDATE crove_meetings.meeting SET audio_retention_date = ${yesterday} WHERE id = $1`, [shredded.meetingId]);
    await retention();
    const out = await drain(shredded.res);
    expect(out.failed).toBe(true);
    expect(out.received).toBeLessThan(shredded.size);

    // The segment the meeting names is replaced by another file while the key stays: the stream notices the file changed and stops.
    const replaced = await long('Replaced while playing');
    const other = randomUUID();
    await rows("INSERT INTO crove_kernel.file (org_id, id, filename, content_type, size_bytes, sha256, storage_key, source, created_by) VALUES ($1, $2, 'swap.opus', 'audio/ogg', 10, $3, $4, 'meeting_audio', $5)", [orgId, other, 'b'.repeat(64), `org/${orgId}/${'b'.repeat(64)}`, userIds.get('recorder')]);
    await rows('UPDATE crove_meetings.audio_segment SET file_id = $1 WHERE meeting_id = $2', [other, replaced.meetingId]);
    const swapped = await drain(replaced.res);
    expect(swapped.failed).toBe(true);
    expect(swapped.received).toBeLessThan(replaced.size);
    await rows('DELETE FROM crove_kernel.file WHERE id = $1', [other]).catch(() => undefined);
  });

  it('is final from the day a period ends, before the nightly job has run', async () => {
    const meetingId = await createMeeting('recorder', { title: 'Due today' });
    await upload('recorder', meetingId, 'audio', 'a');
    expect((await play('recorder', meetingId, 'audio')).status).toBe(200);
    await rows(`UPDATE crove_meetings.meeting SET audio_retention_date = ${yesterday} WHERE id = $1`, [meetingId]);
    expect((await play('recorder', meetingId, 'audio')).status).toBe(404);
    expect((await rpc('meetings/get', 'recorder', { meetingId })).status).toBe(200);
    await rows(`UPDATE crove_meetings.meeting SET text_retention_date = ${yesterday} WHERE id = $1`, [meetingId]);
    expect((await rpc('meetings/get', 'recorder', { meetingId })).status).toBe(404);
    const listed = await rpc('meetings/list', 'recorder', {});
    expect(JSON.stringify(listed.body)).not.toContain(meetingId);
  });

  it('keeps text until a person deletes it when the org chose that, and never shreds before the date', async () => {
    await rpc('meetings/settings/set', 'owner', { audioRetentionDays: 30, videoRetentionDays: 7, textRetentionDays: 0 });
    const meetingId = await createMeeting('recorder', { title: 'Keep the words' });
    await upload('recorder', meetingId, 'audio', 'a');
    await rpc('meetings/settings/set', 'owner', { audioRetentionDays: 30, videoRetentionDays: 7, textRetentionDays: 365 });
    await rows(`UPDATE crove_meetings.meeting SET audio_retention_date = ${yesterday} WHERE id = $1`, [meetingId]);
    await retention();
    expect(await count('SELECT 1 FROM crove_meetings.meeting WHERE id = $1', [meetingId])).toBe(1);
    expect(await count('SELECT 1 FROM crove_meetings.media_key WHERE meeting_id = $1', [meetingId])).toBe(0);
    // The definers check the date themselves: a command for a meeting that is not due shreds nothing.
    const future = await createMeeting('recorder', { title: 'Not yet' });
    await upload('recorder', future, 'audio', 'a');
    for (const kind of ['audio', 'text'] as const) {
      await expect(worker.execute('meetings.retention.shred', { meetingId: future, kind }, { actor: SYSTEM, orgId })).resolves.toMatchObject({ applied: false });
    }
    expect(await count('SELECT 1 FROM crove_meetings.media_key WHERE meeting_id = $1', [future])).toBe(1);
  });

  it('lets only the worker login run the retention definers, in the system context of the org they act on', async () => {
    const asApp = await admin(async (c) => {
      await c.query('SET ROLE crove_app');
      try {
        await c.query('SELECT * FROM crove_meetings.meetings_due(10)');
        return 'ran';
      } catch (error) {
        return (error as Error).message;
      }
    });
    expect(asApp).toMatch(/permission denied/);
    for (const call of ['SELECT * FROM crove_meetings.meetings_orphan_media(10)', 'SELECT * FROM crove_meetings.meetings_deleted_since(now())', "SELECT crove_meetings.meeting_text_purge(gen_random_uuid(), gen_random_uuid())"]) {
      const out = await admin(async (c) => {
        await c.query('SET ROLE crove_app');
        return c.query(call).then(() => 'ran').catch((e: Error) => e.message);
      });
      expect(out, call).toMatch(/permission denied/);
    }
    // The worker login outside a system context, or in another org's, is refused by the definers themselves.
    for (const call of ["SELECT crove_meetings.meeting_shred(gen_random_uuid(), gen_random_uuid(), 'audio')", 'SELECT crove_meetings.meeting_text_purge(gen_random_uuid(), gen_random_uuid())', 'SELECT crove_meetings.meeting_replay_shred(gen_random_uuid(), gen_random_uuid())', 'SELECT crove_meetings.meeting_media_discard(gen_random_uuid(), gen_random_uuid())']) {
      const out = await withWorker(async (c) => c.query(call).then(() => 'ran').catch((e: Error) => e.message));
      expect(out, call).toMatch(/MEETINGS_WORKER_ONLY/);
      const inOrg = await withWorker(async (c) => {
        await c.query('BEGIN');
        try {
          await c.query('SELECT crove_kernel.enter_system_context($1)', [orgId]);
          return await c.query(call).then(() => 'ran').catch((e: Error) => e.message);
        } finally {
          await c.query('ROLLBACK');
        }
      });
      expect(inOrg, `${call} for another org`).toMatch(/MEETINGS_WORKER_ONLY/);
    }
    // The scans that read across orgs refuse a session that is inside an org's context.
    const scanInOrg = await withWorker(async (c) => {
      await c.query('BEGIN');
      try {
        await c.query('SELECT crove_kernel.enter_system_context($1)', [orgId]);
        return await c.query('SELECT * FROM crove_meetings.meetings_due(10)').then(() => 'ran').catch((e: Error) => e.message);
      } finally {
        await c.query('ROLLBACK');
      }
    });
    expect(scanInOrg).toMatch(/MEETINGS_WORKER_ONLY/);
    // A user's command cannot reach the system commands.
    const inputs: Array<[string, unknown]> = [
      ['meetings.retention.shred', { meetingId: randomUUID(), kind: 'text' }],
      ['meetings.shred.replay', { meetingId: randomUUID() }],
      ['meetings.media.discard', { fileId: randomUUID() }],
    ];
    for (const [name, input] of inputs) {
      await expect(worker.execute(name, input, { actor: { type: 'user', userId: userIds.get('owner')!, aal: 'aal2', mfaAt: Math.floor(Date.now() / 1000) }, orgId }), name).rejects.toMatchObject({ status: 403 });
    }

  });

  it('removes nothing but orphan meeting media, and leaves an object another file row names', async () => {
    const meetingId = await createMeeting('recorder', { title: 'Orphan test' });
    await upload('recorder', meetingId, 'audio', 'a');
    const live = (await rows<{ id: string; storage_key: string }>("SELECT id, storage_key FROM crove_kernel.file WHERE org_id = $1 AND filename = $2", [orgId, `meeting-${meetingId}.opus`]))[0]!;
    // A live segment is never an orphan, and the discard refuses it.
    await sweep();
    expect(store.storage.has(live.storage_key)).toBe(true);
    await expect(worker.execute('meetings.media.discard', { fileId: live.id }, { actor: SYSTEM, orgId })).resolves.toEqual({ discarded: false });
    // A document is no meeting media: the discard cannot delete it.
    const doc = randomUUID();
    await rows("INSERT INTO crove_kernel.file (org_id, id, filename, content_type, size_bytes, sha256, storage_key, source, created_by) VALUES ($1, $2, 'inv.pdf', 'application/pdf', 10, $3, $4, 'upload', $5)", [orgId, doc, 'a'.repeat(64), `org/${orgId}/${'a'.repeat(64)}`, userIds.get('owner')]);
    await expect(worker.execute('meetings.media.discard', { fileId: doc }, { actor: SYSTEM, orgId })).resolves.toEqual({ discarded: false });
    expect(await count('SELECT 1 FROM crove_kernel.file WHERE id = $1', [doc])).toBe(1);

    // An orphan whose object cannot be deleted keeps its row for the next sweep.
    await rows('DELETE FROM crove_meetings.audio_segment WHERE meeting_id = $1', [meetingId]);
    store.deleteFails = true;
    const failed = await sweep();
    store.deleteFails = false;
    expect(failed.failed).toBeGreaterThanOrEqual(1);
    expect(await count('SELECT 1 FROM crove_kernel.file WHERE id = $1', [live.id])).toBe(1);
    expect((await sweep()).deleted).toBeGreaterThanOrEqual(1);
    expect(store.storage.has(live.storage_key)).toBe(false);
    expect(await count('SELECT 1 FROM crove_kernel.file WHERE id = $1', [live.id])).toBe(0);
  });

  it('removes the object and the file row of a meeting a person deletes, and writes its shred reference once; a restore then the replay leaves it unreadable', async () => {
    const meetingId = await createMeeting('recorder', { title: 'Deleted by its recorder', keepVideo: true, readerUserIds: [userIds.get('attendee')] });
    await upload('recorder', meetingId, 'audio', 'a');
    await upload('recorder', meetingId, 'video', 'v');
    const live = await createMeeting('recorder', { title: 'Alive' });
    await upload('recorder', live, 'audio', 'l');

    // What a backup taken now holds of the meeting, in foreign key order.
    const snapshot = await admin(async (c) => {
      const q = async (t: string, key: string) => (await c.query(`SELECT * FROM ${t} WHERE ${key} = $1`, [meetingId])).rows;
      const meeting = await q('crove_meetings.meeting', 'id');
      const segments = await q('crove_meetings.audio_segment', 'meeting_id');
      const videos = await q('crove_meetings.meeting_video', 'meeting_id');
      const fileIds = [...segments, ...videos].map((r) => r.file_id as string);
      const files = (await c.query('SELECT * FROM crove_kernel.file WHERE id = ANY($1::uuid[])', [fileIds])).rows;
      return { meeting, readers: await q('crove_meetings.meeting_reader', 'meeting_id'), segments, videos, keys: await q('crove_meetings.media_key', 'meeting_id'), files };
    });
    const keys = snapshot.files.map((f) => f.storage_key as string);
    expect(keys).toHaveLength(2);

    const deleted = await rpc('meetings/delete', 'recorder', { meetingId });
    expect(deleted.status).toBe(200);
    expect(await count('SELECT 1 FROM crove_meetings.meeting WHERE id = $1', [meetingId])).toBe(0);
    // The ciphertext objects and the file rows go with the sweep ("as the store allows").
    expect((await sweep()).deleted).toBe(2);
    for (const key of keys) expect(store.storage.has(key)).toBe(false);
    expect(await count("SELECT 1 FROM crove_kernel.file WHERE org_id = $1 AND filename LIKE $2", [orgId, `meeting-${meetingId}.%`])).toBe(0);

    // The reference goes to the archive store, once, with ids and a time only.
    const since = new Date(Date.now() - 3_600_000);
    const written = new Set<string>();
    const first = await syncShredRefs({ workerDb, store: archive, since, written });
    expect(first.written).toBe(1);
    expect(first.seen).toBeGreaterThanOrEqual(1);
    const refKey = shredRefKey(orgId, meetingId);
    const ref = JSON.parse(new TextDecoder().decode((await archive.get(refKey))!));
    expect(ref).toEqual({ format: 'crove-shred-ref', version: 1, kind: 'meetings.meeting', orgId, meetingId, deletedAt: expect.any(String) });
    expect(readFileSync(join(archiveDir, refKey), 'utf8')).not.toContain('Deleted by its recorder');
    expect((await syncShredRefs({ workerDb, store: archive, since })).written).toBe(0);
    expect((await syncShredRefs({ workerDb, store: archive, since })).seen).toBe(first.seen);
    expect(readdirSync(join(archiveDir, 'shred/v1')).filter((n) => n === `meeting-${orgId}-${meetingId}.json`)).toHaveLength(1);

    // A restore brings the rows (and the keys) back: the meeting is readable again.
    await admin(async (c) => {
      const insert = async (table: string, rowsOf: Array<Record<string, unknown>>) => {
        for (const row of rowsOf) {
          const cols = Object.keys(row);
          await c.query(`INSERT INTO ${table} (${cols.map((x) => `"${x}"`).join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')})`, cols.map((x) => row[x]));
        }
      };
      await insert('crove_kernel.file', snapshot.files);
      await insert('crove_meetings.meeting', snapshot.meeting);
      await insert('crove_meetings.meeting_reader', snapshot.readers);
      await insert('crove_meetings.audio_segment', snapshot.segments);
      await insert('crove_meetings.meeting_video', snapshot.videos);
      await insert('crove_meetings.media_key', snapshot.keys);
    });
    for (const key of keys) store.storage.set(key, new Uint8Array([1, 2, 3]));
    expect(await count('SELECT 1 FROM crove_meetings.media_key WHERE meeting_id = $1', [meetingId])).toBe(2);
    expect((await rpc('meetings/get', 'attendee', { meetingId })).status).toBe(200);

    // The replay deletes it again, and only it: the live meeting keeps its key and its audio.
    const replay = await replayShreds({ runtime: worker, workerDb, store: archive, log: quiet });
    expect(replay).toMatchObject({ failed: 0, deleted: 1 });
    expect(await count('SELECT 1 FROM crove_meetings.meeting WHERE id = $1', [meetingId])).toBe(0);
    expect(await count('SELECT 1 FROM crove_meetings.media_key WHERE meeting_id = $1', [meetingId])).toBe(0);
    expect((await rpc('meetings/get', 'attendee', { meetingId })).status).toBe(404);
    expect((await play('recorder', meetingId, 'audio')).status).toBeGreaterThanOrEqual(400);
    expect((await sweep()).deleted).toBe(2);
    for (const key of keys) expect(store.storage.has(key)).toBe(false);
    expect(await count('SELECT 1 FROM crove_meetings.media_key WHERE meeting_id = $1', [live])).toBe(1);
    expect((await play('recorder', live, 'audio')).status).toBe(200);

    // Idempotent: a second replay changes nothing.
    expect(await replayShreds({ runtime: worker, workerDb, store: archive, log: quiet })).toMatchObject({ failed: 0, deleted: 0 });
    expect((await play('recorder', live, 'audio')).status).toBe(200);
  });

  it('writes the shred reference of an owner deletion too, and a replay over a store listing only other meetings leaves every live meeting', async () => {
    const meetingId = await createMeeting('recorder', { title: 'Owner removes' });
    await upload('recorder', meetingId, 'audio', 'a');
    expect((await rpc('meetings/ownerDelete', 'owner', { meetingId }, slug, true)).status).toBe(200);
    const other = new LocalArchiveStore(mkdtempSync(join(tmpdir(), 'crove-shred-other-')));
    // The store lists a meeting that never existed in this database and one whose reference does not parse.
    await other.put(shredRefKey(orgId, randomUUID()), new TextEncoder().encode(JSON.stringify({ format: 'crove-shred-ref', version: 1, kind: 'meetings.meeting', orgId, meetingId: randomUUID(), deletedAt: new Date().toISOString() })));
    await other.put('shred/v1/garbage.json', new TextEncoder().encode('{"hello":1}'));
    const stay = await createMeeting('recorder', { title: 'Stays' });
    await upload('recorder', stay, 'audio', 's');
    const alerts: string[] = [];
    const out = await replayShreds({ runtime: worker, workerDb, store: other, log: quiet, alert: (line) => alerts.push(line) });
    // A reference that could not be replayed raises an alert (a deleted meeting may still be readable after a restore).
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain('2 shred reference');
    // The first names a different id than its key does: skipped, never run.
    expect(out.deleted).toBe(0);
    expect(out.failed).toBe(2);
    expect(await count('SELECT 1 FROM crove_meetings.media_key WHERE meeting_id = $1', [stay])).toBe(1);
    expect((await syncShredRefs({ workerDb, store: archive, since: new Date(Date.now() - 3_600_000) })).written).toBeGreaterThanOrEqual(1);
    expect(await archive.get(shredRefKey(orgId, meetingId))).not.toBeNull();
  });

  it('alerts when the shred references cannot be written for several passes, once, and recovers when the store does', async () => {
    const meetingId = await createMeeting('recorder', { title: 'Reference writer down' });
    expect((await rpc('meetings/delete', 'recorder', { meetingId })).status).toBe(200);
    let down = true;
    const flaky = {
      put: async (key: string, body: Uint8Array) => {
        if (down) throw new Error('archive store unavailable');
        return archive.put(key, body);
      },
      get: (key: string) => archive.get(key),
      list: (prefix: string) => archive.list(prefix),
      describe: () => 'flaky',
    };
    const alerts: string[] = [];
    const writer = createShredRefSync({ workerDb, store: flaky, alert: (line) => alerts.push(line), log: quiet });
    for (let i = 1; i < SHRED_REF_ALERT_AFTER; i++) {
      expect(await writer.pass()).toBeNull();
      expect(alerts).toEqual([]);
    }
    expect(await writer.pass()).toBeNull();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain('ALERT');
    // Still failing: no second alert for the next passes (the next comes an hour of passes later).
    await writer.pass();
    expect(alerts).toHaveLength(1);
    down = false;
    const ok = await writer.pass();
    expect(ok).not.toBeNull();
    expect(writer.failures).toBe(0);
    expect(await archive.get(shredRefKey(orgId, meetingId))).not.toBeNull();
  });

  it('leaves no meeting row, key or object when the org is purged, and carries no media in the export', async () => {
    const created = await rpc('org/create', 'purgeOwner', { name: `Purge Org ${randomUUID().slice(0, 6)}`, idempotencyKey: randomUUID() }, null);
    expect(created.status).toBe(200);
    const purgeSlug = String(created.body.slug);
    const purgeOrgId = String(created.body.orgId);
    userIds.set('purgeOwner', (await rows<{ id: string }>('SELECT id FROM crove_kernel.user_account WHERE email = $1', [accounts.get('purgeOwner')?.email]))[0]!.id);
    const shared = await createMeeting('purgeOwner', { title: 'Shared with all', visibility: 'org', keepVideo: true }, purgeSlug);
    const hidden = await createMeeting('purgeOwner', { title: 'Attendees only' }, purgeSlug);
    await upload('purgeOwner', shared, 'audio', 'a', purgeSlug);
    await upload('purgeOwner', shared, 'video', 'v', purgeSlug);
    await upload('purgeOwner', hidden, 'audio', 'h', purgeSlug);
    const keysBefore = [...store.storage.keys()].filter((k) => k.startsWith(`org/${purgeOrgId}/`));
    expect(keysBefore.length).toBe(3);
    // An ordinary document of the same org (a row only, no bytes needed): the export must still list it.
    const docId = randomUUID();
    await rows("INSERT INTO crove_kernel.file (org_id, id, filename, content_type, size_bytes, sha256, storage_key, source, created_by) VALUES ($1, $2, 'contract.pdf', 'application/pdf', 10, $3, $4, 'upload', $5)", [purgeOrgId, docId, 'c'.repeat(64), `org/${purgeOrgId}/${'c'.repeat(64)}`, userIds.get('purgeOwner')]);

    // The export: the shared meeting, a count for the attendees-only one, no file row of any recording.
    const exported = async (table: string) => {
      const lines: string[] = [];
      await worker.stream('kernel.org.export.snapshot', { table }, { actor: SYSTEM, orgId: purgeOrgId }, async (raw) => {
        lines.push(...(raw as { lines: string[] }).lines);
      });
      return lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    };
    const exportedMeetings = await exported('meetings.meeting');
    expect(exportedMeetings.map((m) => m.id)).toEqual([shared]);
    expect(await exported('meetings.private_count')).toEqual([expect.objectContaining({ org_id: purgeOrgId, meetings: 1 })]);
    expect(JSON.stringify(await exported('meetings.meeting'))).not.toContain('Attendees only');
    const exportedFiles = await exported('kernel.file');
    expect(exportedFiles.filter((f) => String(f.source).startsWith('meeting_'))).toEqual([]);
    // The filter is on the source alone: the ordinary document is the one file row exported.
    expect(exportedFiles.map((f) => f.id)).toEqual([docId]);
    expect((await rows<{ n: string }>("SELECT count(*)::text AS n FROM crove_kernel.file WHERE org_id = $1 AND source LIKE 'meeting_%'", [purgeOrgId]))[0]!.n).toBe('3');

    // A meeting deleted before the purge leaves a shred reference that outlives the org (it is under Object Lock).
    expect((await rpc('meetings/delete', 'purgeOwner', { meetingId: hidden }, purgeSlug)).status).toBe(200);
    await syncShredRefs({ workerDb, store: archive, since: new Date(Date.now() - 3_600_000) });
    expect(await archive.get(shredRefKey(purgeOrgId, hidden))).not.toBeNull();

    // Offboarding with an export of the current format, 31 days old (as the purge's own invariant test sets it up), then the purge.
    await admin(async (c) => {
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query("UPDATE crove_kernel.tenant SET status = 'offboarding' WHERE org_id = $1", [purgeOrgId]);
      await c.query('COMMIT');
      for (const [command, actorType, actorId, daysAgo, detail] of [
        ['kernel.org.offboard', 'user', userIds.get('purgeOwner'), 36, {}],
        ['kernel.org.export.record', 'system', null, 31, { format: 'crove.org-export.v2' }],
      ] as const) {
        await c.query(
          `INSERT INTO crove_kernel.audit_event (org_id, occurred_at, actor_type, actor_id, command, command_id, outcome, input_sha256, detail) VALUES ($1, $2, $3, $4, $5, $6, 'ok', $7, $8)`,
          [purgeOrgId, new Date(Date.now() - daysAgo * 86_400_000), actorType, actorId, command, randomUUID(), '0'.repeat(64), JSON.stringify(detail)],
        );
      }
    });
    await expect(purgeOrg(worker, 30, { ref: purgeOrgId, reason: 'test' })).resolves.toMatchObject({ kind: 'purged', orgId: purgeOrgId });
    for (const t of ['meeting', 'meeting_reader', 'audio_segment', 'meeting_video', 'media_key']) {
      expect(await count(`SELECT 1 FROM crove_meetings.${t} WHERE org_id = $1`, [purgeOrgId]), t).toBe(0);
    }
    expect(await count("SELECT 1 FROM crove_kernel.file WHERE org_id = $1 AND source LIKE 'meeting_%'", [purgeOrgId])).toBe(0);
    expect([...store.storage.keys()].filter((k) => k.startsWith(`org/${purgeOrgId}/`))).toEqual([]);
    // The replay over that reference skips the purged org: nothing to do, no failure, no alert; the retention and the sweep do not fail on it either.
    const alerts: string[] = [];
    const replayed = await replayShreds({ runtime: worker, workerDb, store: archive, log: quiet, alert: (line) => alerts.push(line) });
    expect(replayed.skipped).toBeGreaterThanOrEqual(1);
    expect(replayed.failed).toBe(0);
    expect(alerts).toEqual([]);
    expect((await retention()).failed).toBe(0);
    expect((await sweep()).failed).toBe(0);
    // The other org is untouched.
    expect(await count('SELECT 1 FROM crove_meetings.meeting WHERE org_id = $1', [orgId])).toBeGreaterThan(0);
    void purgeSlug;
  });
});

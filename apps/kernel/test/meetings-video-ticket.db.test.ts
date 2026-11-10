// SPDX-License-Identifier: AGPL-3.0-only
// Playing a meeting's video with <video src> by a short-lived signed ticket (#2703): the ticket route, the stream route, and
// that every range re-checks the session and the reader's access in the database.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { kernelCommands, kernelQueries } from '@crove/kernel';
import { BlobNotFoundError, DomainError, Runtime, sha256Hex, type BlobStore, type CredentialBroker, type SessionStatusSource } from '@crove/kernel-runtime';
import { financeCommands, financeQueries } from '@crove/mod-finance';
import { meetingsCommands, meetingsQueries } from '@crove/mod-meetings';
import { createAuthenticator } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { ConcurrencyLimiter } from '../src/concurrency.ts';
import { createHttpApp, type HttpDeps } from '../src/http.ts';
import { installJsonLogs } from '../src/log.ts';
import { MEDIA_TICKET_KEY_LABEL, signMediaTicket, type MediaTicketPayload } from '../src/media-ticket.ts';
import { RateLimiter } from '../src/rate-limit.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const SECRET = 'test-only-video-ticket-secret-0123456789-abcdef';
const ISSUER = 'crove-auth-video-ticket';
const KEY_ID = 'k1-video-ticket-test';

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
    return (await this.get(key)).subarray(start, end + 1);
  }
  async delete(key: string): Promise<void> {
    this.storage.delete(key);
    this.staged.delete(key);
  }
  readonly direct = {
    presignUpload: async (key: string, maxBytes: number) => ({ url: 'memory://test', fields: { key }, expiresAt: new Date(Date.now() + 300_000), maxBytes }),
    presignDownload: async () => null,
    readStaged: async (key: string, maxBytes: number) => {
      const bytes = this.staged.get(key);
      if (!bytes) throw new BlobNotFoundError(key);
      return { bytes, sha256: sha256Hex(bytes), maxBytes };
    },
    openStaged: async (key: string) => {
      const bytes = this.staged.get(key);
      if (!bytes) throw new BlobNotFoundError(key);
      async function* chunks() {
        for (let at = 0; at < bytes!.byteLength; at += 65_536) yield bytes!.subarray(at, at + 65_536);
      }
      return { size: bytes.byteLength, chunks: chunks() };
    },
  } as unknown as BlobStore['direct'];
}

const mp4 = (size: number) => Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70]), randomBytes(size - 8)]);

suite('meeting video tickets (#2703)', () => {
  const dbName = `crove_test_video_ticket_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let store: TestBlobStore;
  let broker: CredentialBroker;
  let app: ReturnType<typeof createHttpApp>;
  let deps: HttpDeps;
  const revokedSessions = new Set<string>();
  const accounts = new Map<string, { subject: string; email: string; session: string }>();
  const userIds = new Map<string, string>();
  let orgId = '';
  let slug = '';
  let restoreLogs: (() => void) | null = null;

  afterEach(() => {
    restoreLogs?.();
    restoreLogs = null;
  });

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
      who = { subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@video-ticket.test`, session: randomUUID() };
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

  async function join(name: string, role: 'member' | 'viewer') {
    await token(name);
    const email = accounts.get(name)?.email;
    const invited = await rpc('org/invite', 'owner', { email, role }, slug, true);
    expect(invited.status).toBe(200);
    const accepted = await rpc('invites/accept', name, { token: String(invited.body.acceptPath).split('#')[1] }, null);
    expect(accepted.status).toBe(200);
    userIds.set(name, await admin(async (c) => (await c.query<{ id: string }>('SELECT id FROM crove_kernel.user_account WHERE email = $1', [email])).rows[0]!.id));
  }

  // A meeting recorded by `recorder`, readable by `attendee` too, with this video sealed into it.
  async function videoMeeting(bytes: Buffer | null) {
    const created = await rpc('meetings/create', 'recorder', {
      title: `Ticket ${randomUUID().slice(0, 6)}`,
      visibility: 'attendees',
      keepVideo: true,
      consentMethod: 'told_at_start',
      readerUserIds: [userIds.get('attendee')!],
    });
    expect(created.status).toBe(200);
    const meetingId = String(created.body.meetingId);
    if (bytes) {
      const uploadId = randomUUID();
      const stagingKey = `staging/${randomBytes(32).toString('hex')}`;
      store.staged.set(stagingKey, bytes);
      await admin((c) =>
        c.query(
          `INSERT INTO crove_kernel.file_upload (org_id, id, staging_key, created_by, max_bytes, purpose, created_at, expires_at)
           VALUES ($1, $2, $3, $4, $5, 'meeting_video', now(), now() + interval '5 minutes')`,
          [orgId, uploadId, stagingKey, userIds.get('recorder'), 2 * 1024 * 1024 * 1024],
        ),
      );
      const claim = await app.request(`/api/meetings/${meetingId}/media`, {
        method: 'POST',
        headers: { authorization: `Bearer ${await token('recorder')}`, 'content-type': 'application/json', 'x-crove-org': slug },
        body: JSON.stringify({ uploadId, kind: 'video' }),
      });
      expect(claim.status).toBe(200);
    }
    return meetingId;
  }

  async function issue(name: string, meetingId: string, target = app) {
    const res = await target.request(`/api/meetings/${meetingId}/video/ticket`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await token(name)}`, 'x-crove-org': slug },
    });
    return { res, body: (await res.json()) as { ticket?: string; expiresInSeconds?: number; code?: string } };
  }

  const stream = (meetingId: string, ticket: string, init: RequestInit = {}, target = app) =>
    target.request(`/api/meetings/${meetingId}/video/stream?ticket=${ticket}`, init);

  const bearerPlay = async (name: string, meetingId: string, range?: string) =>
    app.request(`/api/meetings/${meetingId}/video`, {
      headers: { authorization: `Bearer ${await token(name)}`, 'x-crove-org': slug, ...(range ? { range } : {}) },
    });

  // A ticket signed as the server signs it, for what the issue route would never give (a stolen key, a forged payload).
  const keyOf = () => (broker.deriveKey as (id: string, label: string) => Buffer)(KEY_ID, MEDIA_TICKET_KEY_LABEL);
  async function forge(name: string, meetingId: string, over: Partial<MediaTicketPayload> = {}) {
    const real = await issue('recorder', meetingId);
    const [, body] = real.body.ticket!.split('.') as [string, string];
    const base = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as MediaTicketPayload;
    const who = accounts.get(name)!;
    const now = Math.floor(Date.now() / 1000);
    return signMediaTicket(keyOf(), { ...base, userId: userIds.get(name)!, sessionId: who.session, iat: now, exp: now + 300, ...over });
  }

  const INVALID = { code: 'VIDEO_TICKET_INVALID' };

  beforeAll(async () => {
    store = new TestBlobStore();
    broker = {
      keyId: KEY_ID,
      keyIds: [KEY_ID],
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
    const config = loadConfig({ DATABASE_URL: appUrl.toString(), AUTH_JWT_SECRET: SECRET, AUTH_ISSUER: ISSUER, AUTH_SESSION_CHECK: 'off', MIGRATIONS_DIR: MIGRATIONS, WEB_DIST: '/nonexistent' });

    // A session source that can revoke: the runtime asks it in the transaction of every query, as it asks the database in production.
    const sessions: SessionStatusSource = {
      mode: 'off',
      liveCheckForR3: false,
      async check(_trx, actor) {
        if (revokedSessions.has(actor.sessionId)) throw new DomainError('SESSION_REVOKED', 401, 'The session was revoked');
      },
    };
    const runtime = new Runtime(db, { manifests: TEST_MANIFESTS, sessions, stepUp: 'required' }).register({
      commands: [...kernelCommands, ...financeCommands, ...meetingsCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries, ...meetingsQueries],
    });
    deps = { config, runtime, store, broker, authenticate: createAuthenticator(config, db), pool, aiEnabled: false };
    app = createHttpApp(deps);

    const created = await rpc('org/create', 'owner', { name: `Video Ticket Org ${randomUUID().slice(0, 6)}`, idempotencyKey: randomUUID() }, null);
    expect(created.status).toBe(200);
    slug = String(created.body.slug);
    orgId = String(created.body.orgId);
    userIds.set('owner', await admin(async (c) => (await c.query<{ id: string }>('SELECT id FROM crove_kernel.user_account WHERE email = $1', [accounts.get('owner')?.email])).rows[0]!.id));
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

  it('issues a ticket to a reader only, for at most ten minutes and with no-store', async () => {
    const meetingId = await videoMeeting(mp4(3000));
    const ok = await issue('attendee', meetingId);
    expect(ok.res.status).toBe(200);
    expect(ok.res.headers.get('cache-control')).toBe('no-store');
    expect(ok.body.ticket).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
    // The bearer token lives 15 minutes, so the ten minute cap decides.
    expect(ok.body.expiresInSeconds).toBe(600);
    // A member who is not a reader, and a viewer, get nothing; a request with no token reaches no handler.
    const other = await issue('otherMember', meetingId);
    // The status is the bearer route's own for a member who cannot read the meeting (it does not say the meeting exists).
    expect(other.res.status).toBe((await bearerPlay('otherMember', meetingId)).status);
    expect(other.res.status).toBeGreaterThanOrEqual(400);
    expect(other.body.ticket).toBeUndefined();
    const viewer = await issue('viewer', meetingId);
    expect(viewer.res.status).toBeGreaterThanOrEqual(400);
    expect(viewer.body.ticket).toBeUndefined();
    const anon = await app.request(`/api/meetings/${meetingId}/video/ticket`, { method: 'POST' });
    expect(anon.status).toBe(401);
    // The module is the same one the bearer route needs: a GET is no ticket request.
    expect((await app.request(`/api/meetings/${meetingId}/video/ticket`, { headers: { authorization: `Bearer ${await token('attendee')}`, 'x-crove-org': slug } })).status).not.toBe(200);
  });

  it('is capped at the bearer token\'s own expiry', async () => {
    const meetingId = await videoMeeting(mp4(3000));
    const now = Math.floor(Date.now() / 1000);
    const shortLived = createHttpApp({
      ...deps,
      authenticate: async (header) => ({ ...(await deps.authenticate(header)), tokenExp: now + 90 }),
    });
    const short = await issue('recorder', meetingId, shortLived);
    expect(short.res.status).toBe(200);
    expect(short.body.expiresInSeconds).toBeGreaterThan(80);
    expect(short.body.expiresInSeconds).toBeLessThanOrEqual(90);
    // No exp on the token: no ticket. An exp in the past: no ticket.
    const noExp = createHttpApp({
      ...deps,
      authenticate: async (header) => {
        const user = { ...(await deps.authenticate(header)) };
        delete user.tokenExp;
        return user;
      },
    });
    expect((await issue('recorder', meetingId, noExp)).res.status).toBe(503);
    const past = createHttpApp({ ...deps, authenticate: async (header) => ({ ...(await deps.authenticate(header)), tokenExp: now - 1 }) });
    expect((await issue('recorder', meetingId, past)).res.status).toBe(401);
  });

  it('refuses a ticket for a meeting without video, and answers 503 when the broker holds no key', async () => {
    const without = await videoMeeting(null);
    const refused = await issue('recorder', without);
    expect(refused.res.status).toBeGreaterThanOrEqual(400);
    expect(refused.body.ticket).toBeUndefined();
    // The bearer route gives the same refusal.
    const bearer = await bearerPlay('recorder', without);
    expect(bearer.status).toBe(refused.res.status);
    expect(((await bearer.json()) as { code: string }).code).toBe(refused.body.code);

    const meetingId = await videoMeeting(mp4(3000));
    const noKey = createHttpApp({ ...deps, broker: { id: 'none', seal: () => { throw new Error('no'); }, open: () => { throw new Error('no'); } } as unknown as CredentialBroker });
    const none = await issue('recorder', meetingId, noKey);
    expect(none.res.status).toBe(503);
    expect(none.body.code).toBe('MEDIA_KEY_UNAVAILABLE');
  });

  it('plays a ticket as the bearer route does: full, 206 ranges, HEAD, with the same bytes and the hardened headers', async () => {
    const bytes = mp4(3000);
    const meetingId = await videoMeeting(bytes);
    const { body } = await issue('attendee', meetingId);
    const ticket = body.ticket!;

    const whole = await stream(meetingId, ticket);
    expect(whole.status).toBe(200);
    expect(Buffer.from(await whole.arrayBuffer()).equals(bytes)).toBe(true);

    for (const range of ['bytes=0-99', 'bytes=1000-1499', 'bytes=2900-', 'bytes=-100']) {
      const viaTicket = await stream(meetingId, ticket, { headers: { range } });
      const viaBearer = await bearerPlay('attendee', meetingId, range);
      expect(viaTicket.status, range).toBe(206);
      expect(viaBearer.status, range).toBe(206);
      expect(viaTicket.headers.get('content-range'), range).toBe(viaBearer.headers.get('content-range'));
      const [a, b] = [Buffer.from(await viaTicket.arrayBuffer()), Buffer.from(await viaBearer.arrayBuffer())];
      expect(a.equals(b), range).toBe(true);
      const start = range === 'bytes=-100' ? 2900 : Number(range.slice(6).split('-')[0]);
      expect(a.equals(bytes.subarray(start, start + a.length)), range).toBe(true);
    }
    expect((await stream(meetingId, ticket, { headers: { range: 'bytes=5000-6000' } })).status).toBe(416);

    const partial = await stream(meetingId, ticket, { headers: { range: 'bytes=0-9' } });
    expect(partial.headers.get('referrer-policy')).toBe('no-referrer');
    expect(partial.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
    expect(partial.headers.get('cache-control')).toBe('private, no-store');
    expect(partial.headers.get('x-content-type-options')).toBe('nosniff');
    expect(partial.headers.get('content-disposition')).toBe('inline');
    expect(partial.headers.get('accept-ranges')).toBe('bytes');
    expect([...partial.headers.keys()].filter((k) => k.startsWith('access-control-'))).toEqual([]);
    await partial.arrayBuffer();

    const head = await stream(meetingId, ticket, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe(String(bytes.length));
    expect(head.headers.get('content-disposition')).toBe('inline');
    expect(await head.text()).toBe('');
    // Only GET and HEAD.
    expect((await stream(meetingId, ticket, { method: 'POST' })).status).not.toBe(200);
    expect((await stream(meetingId, ticket, { method: 'DELETE' })).status).not.toBe(200);
  });

  it('sends no CORS header for an allowed origin, so no page of another origin can read it', async () => {
    const config = loadConfig({
      DATABASE_URL: 'postgres://localhost/x',
      AUTH_JWT_SECRET: SECRET,
      AUTH_ISSUER: ISSUER,
      AUTH_SESSION_CHECK: 'off',
      MIGRATIONS_DIR: MIGRATIONS,
      WEB_DIST: '/nonexistent',
      CORS_ALLOWED_ORIGINS: 'https://app.example.com',
    });
    const cors = createHttpApp({ ...deps, config });
    const meetingId = await videoMeeting(mp4(3000));
    const { body } = await issue('recorder', meetingId, cors);
    const res = await stream(meetingId, body.ticket!, { headers: { origin: 'https://app.example.com', range: 'bytes=0-9' } }, cors);
    expect(res.status).toBe(206);
    expect([...res.headers.keys()].filter((k) => k.startsWith('access-control-'))).toEqual([]);
    await res.arrayBuffer();
  });

  it('answers one 401 with one body for every kind of bad ticket', async () => {
    const meetingId = await videoMeeting(mp4(3000));
    const noVideo = await videoMeeting(null);
    const otherMeeting = await videoMeeting(mp4(3000));
    const good = (await issue('recorder', meetingId)).body.ticket!;
    const [v, body, mac] = good.split('.') as [string, string, string];
    const now = Math.floor(Date.now() / 1000);
    const tamperedPayload = (() => {
      const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<string, unknown>;
      p.userId = userIds.get('attendee');
      return `${v}.${Buffer.from(JSON.stringify(p)).toString('base64url')}.${mac}`;
    })();
    const noVideoTicket = await forge('recorder', meetingId, { meetingId: noVideo });

    const cases: Array<[string, string, string]> = [
      ['no ticket', meetingId, ''],
      ['garbage', meetingId, 'garbage'],
      ['tampered signature', meetingId, `${v}.${body}.${mac.startsWith('A') ? 'B' : 'A'}${mac.slice(1)}`],
      ['tampered payload', meetingId, tamperedPayload],
      ['expired', meetingId, await forge('recorder', meetingId, { iat: now - 700, exp: now - 100 })],
      ['too long lived', meetingId, await forge('recorder', meetingId, { exp: now + 3600 })],
      ['issued in the future', meetingId, await forge('recorder', meetingId, { iat: now + 120, exp: now + 300 })],
      ['another meeting (path)', otherMeeting, good],
      ['another meeting (payload)', meetingId, await forge('recorder', meetingId, { meetingId: otherMeeting })],
      ['audio purpose', meetingId, await forge('recorder', meetingId, { purpose: 'meeting_audio' as never })],
      ['a user who cannot read it', meetingId, await forge('otherMember', meetingId)],
      ['a viewer', meetingId, await forge('viewer', meetingId)],
      ['another org', meetingId, await forge('recorder', meetingId, { orgId: randomUUID() })],
      ['another file', meetingId, await forge('recorder', meetingId, { fileId: randomUUID() })],
      ['another media key id', meetingId, await forge('recorder', meetingId, { keyId: 'k-rotated-away' })],
      ['signed with the wrap key', meetingId, signMediaTicket(broker.deriveKey!(KEY_ID, 'crove.meetings.v1|wrap'), JSON.parse(Buffer.from(body, 'base64url').toString('utf8')))],
    ];
    cases.push(['a meeting without video', noVideo, noVideoTicket]);
    const answers = new Set<string>();
    const fresh = () => createHttpApp({ ...deps, videoTicketFailures: new RateLimiter({ perMinute: 1000 }) });
    for (const [label, id, ticket] of cases) {
      const res = await stream(id, ticket, { headers: { range: 'bytes=0-9' } }, fresh());
      const text = await res.text();
      expect(res.status, label).toBe(401);
      expect(JSON.parse(text), label).toEqual(INVALID);
      answers.add(text);
    }
    expect(answers.size).toBe(1);
  });

  it('refuses audio: no audio route takes a ticket, and a ticket for another kind is invalid', async () => {
    const meetingId = await videoMeeting(mp4(3000));
    const { body } = await issue('recorder', meetingId);
    for (const path of [`/api/meetings/${meetingId}/audio/stream?ticket=${body.ticket}`, `/api/meetings/${meetingId}/audio?ticket=${body.ticket}`]) {
      const res = await app.request(path);
      expect([401, 404]).toContain(res.status);
      expect(res.status === 200).toBe(false);
    }
    const audioTicket = await app.request(`/api/meetings/${meetingId}/audio/ticket`, { method: 'POST', headers: { authorization: `Bearer ${await token('recorder')}`, 'x-crove-org': slug } });
    expect(audioTicket.status).not.toBe(200);
  });

  it('is no bearer token, and is no credential in a query on any other route', async () => {
    const meetingId = await videoMeeting(mp4(3000));
    const { body } = await issue('recorder', meetingId);
    const ticket = body.ticket!;
    const asBearer = { authorization: `Bearer ${ticket}`, 'x-crove-org': slug };
    for (const [method, path] of [
      ['GET', `/api/meetings/${meetingId}/video`],
      ['POST', `/api/meetings/${meetingId}/video/ticket`],
      ['POST', `/api/rpc/meetings/list`],
      ['GET', `/api/export/journal.xlsx`],
    ] as const) {
      const res = await app.request(path, { method, headers: asBearer });
      expect(res.status, `${method} ${path}`).toBe(401);
    }
    // In a query, on the routes a person might try: no bearer, so no answer.
    for (const path of [`/api/meetings/${meetingId}/video?ticket=${ticket}`, `/api/meetings/${meetingId}/audio?ticket=${ticket}`, `/api/files?ticket=${ticket}`, `/api/rpc/meetings/list?ticket=${ticket}`, `/api/stream?ticket=${ticket}`]) {
      const res = await app.request(path);
      expect(res.status, path).not.toBe(200);
      expect([401, 404, 405]).toContain(res.status);
    }
    // And with a real bearer, a ticket in the query of the bearer route changes nothing: the bearer decides.
    const other = await app.request(`/api/meetings/${meetingId}/video?ticket=${ticket}`, { headers: { authorization: `Bearer ${await token('otherMember')}`, 'x-crove-org': slug } });
    expect(other.status).toBe((await bearerPlay('otherMember', meetingId)).status);
    expect(other.status).toBeGreaterThanOrEqual(400);
  });

  it('re-checks the reader on the next range: a reader removed loses access while the ticket is still unexpired', async () => {
    const meetingId = await videoMeeting(mp4(3000));
    const { body } = await issue('attendee', meetingId);
    const first = await stream(meetingId, body.ticket!, { headers: { range: 'bytes=0-9' } });
    expect(first.status).toBe(206);
    await first.arrayBuffer();
    const removed = await rpc('meetings/readers/remove', 'recorder', { meetingId, userId: userIds.get('attendee') });
    expect(removed.status).toBe(200);
    const second = await stream(meetingId, body.ticket!, { headers: { range: 'bytes=10-19' } });
    expect(second.status).toBe(401);
    expect(await second.json()).toEqual(INVALID);
  });

  it('re-checks the session on every range: a revoked session loses access', async () => {
    const meetingId = await videoMeeting(mp4(3000));
    const { body } = await issue('attendee', meetingId);
    const first = await stream(meetingId, body.ticket!, { headers: { range: 'bytes=0-9' } });
    expect(first.status).toBe(206);
    await first.arrayBuffer();
    revokedSessions.add(accounts.get('attendee')!.session);
    try {
      const second = await stream(meetingId, body.ticket!, { headers: { range: 'bytes=10-19' } });
      expect(second.status).toBe(401);
      expect(await second.json()).toEqual(INVALID);
      // The bearer route refuses the same session too.
      expect((await bearerPlay('attendee', meetingId)).status).toBe(401);
    } finally {
      revokedSessions.delete(accounts.get('attendee')!.session);
    }
  });

  it('refuses once the video was re-recorded, its key changed, its retention passed or its key was shredded', async () => {
    const play = async (ticket: string) => {
      const res = await stream(meetingIdOf.current, ticket, { headers: { range: 'bytes=0-9' } });
      await res.arrayBuffer();
      return res;
    };
    const meetingIdOf = { current: '' };
    const run = async (change: (meetingId: string) => Promise<void>) => {
      const meetingId = await videoMeeting(mp4(3000));
      meetingIdOf.current = meetingId;
      const { body } = await issue('recorder', meetingId);
      expect((await play(body.ticket!)).status).toBe(206);
      await change(meetingId);
      const after = await play(body.ticket!);
      expect(after.status).toBe(401);
    };
    // Re-recorded: the meeting now names another file.
    await run((meetingId) =>
      admin(async (c) => {
        const other = (await c.query<{ id: string }>('SELECT f.id FROM crove_kernel.file f WHERE f.org_id = $1 AND f.id NOT IN (SELECT file_id FROM crove_meetings.meeting_video WHERE meeting_id = $2) LIMIT 1', [orgId, meetingId])).rows[0]!.id;
        await c.query('UPDATE crove_meetings.meeting_video SET file_id = $1 WHERE meeting_id = $2', [other, meetingId]);
      }),
    );
    // Resealed under another key id.
    await run((meetingId) => admin(async (c) => void (await c.query(`UPDATE crove_meetings.media_key SET key_id = 'k-resealed' WHERE meeting_id = $1 AND kind = 'video'`, [meetingId]))));
    // Retention date passed.
    await run((meetingId) => admin(async (c) => void (await c.query(`UPDATE crove_meetings.meeting_video SET video_retention_date = current_date - 2 WHERE meeting_id = $1`, [meetingId]))));
    // Key shredded.
    await run((meetingId) => admin(async (c) => void (await c.query(`DELETE FROM crove_meetings.media_key WHERE meeting_id = $1 AND kind = 'video'`, [meetingId]))));
    // The meeting deleted.
    await run(async (meetingId) => void (await rpc('meetings/delete', 'recorder', { meetingId })));
  });

  it('counts every refused ticket against the client budget and answers 429 once it is spent', async () => {
    const meetingId = await videoMeeting(mp4(3000));
    const { body } = await issue('recorder', meetingId);
    const limited = createHttpApp({ ...deps, videoTicketFailures: new RateLimiter({ perMinute: 3 }) });
    for (let i = 0; i < 3; i++) expect((await stream(meetingId, `v1.${'A'.repeat(20)}.${'B'.repeat(43)}`, {}, limited)).status).toBe(401);
    const spent = await stream(meetingId, 'garbage', {}, limited);
    expect(spent.status).toBe(429);
    expect(Number(spent.headers.get('retry-after'))).toBeGreaterThan(0);
    // The same client's valid ticket waits too: the budget is of the client, as for the event stream.
    expect((await stream(meetingId, body.ticket!, { headers: { range: 'bytes=0-9' } }, limited)).status).toBe(429);
    // A well-signed ticket that the database refuses counts as a failure too.
    const another = createHttpApp({ ...deps, videoTicketFailures: new RateLimiter({ perMinute: 2 }) });
    const stranger = await forge('otherMember', meetingId);
    for (let i = 0; i < 2; i++) expect((await stream(meetingId, stranger, {}, another)).status).toBe(401);
    expect((await stream(meetingId, stranger, {}, another)).status).toBe(429);
    // Valid tickets spend nothing.
    const fresh = createHttpApp({ ...deps, videoTicketFailures: new RateLimiter({ perMinute: 1 }) });
    for (let i = 0; i < 3; i++) {
      const ok = await stream(meetingId, body.ticket!, { headers: { range: 'bytes=0-9' } }, fresh);
      expect(ok.status).toBe(206);
      await ok.arrayBuffer();
    }
  });

  it('allows three video streams per user at once, and frees a slot when one ends or is cancelled', async () => {
    const meetingId = await videoMeeting(mp4(5 * 1024 * 1024 + 123));
    const videoStreams = new ConcurrencyLimiter({ total: 10, perKey: 3 });
    const capped = createHttpApp({ ...deps, videoStreams });
    const { body } = await issue('recorder', meetingId, capped);
    // An unranged answer larger than one window is read piece by piece, so its slot is held until its body ends.
    const open = async () => stream(meetingId, body.ticket!, {}, capped);
    const first = await open();
    const second = await open();
    const third = await open();
    expect([first.status, second.status, third.status]).toEqual([200, 200, 200]);
    expect(videoStreams.inUse).toBe(3);
    const fourth = await open();
    expect(fourth.status).toBe(429);
    expect(Number(fourth.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(videoStreams.inUse).toBe(3);
    // The client leaves: the slot is free again.
    await first.body!.cancel();
    await vi.waitFor(() => expect(videoStreams.inUse).toBe(2));
    // A stream read to its end frees its slot.
    const done = await second.arrayBuffer();
    expect(done.byteLength).toBe(5 * 1024 * 1024 + 123);
    await vi.waitFor(() => expect(videoStreams.inUse).toBe(1));
    const again = await open();
    expect(again.status).toBe(200);
    await again.body!.cancel();
    await third.body!.cancel();
    await vi.waitFor(() => expect(videoStreams.inUse).toBe(0));
    // A refusal and a range answer never keep a slot.
    const ranged = await stream(meetingId, body.ticket!, { headers: { range: 'bytes=0-9' } }, capped);
    await ranged.arrayBuffer();
    expect((await stream(meetingId, 'garbage', {}, capped)).status).toBe(401);
    await vi.waitFor(() => expect(videoStreams.inUse).toBe(0));
  });

  it('prints no ticket and no query string on any log line', async () => {
    const lines: string[] = [];
    restoreLogs = installJsonLogs({ role: 'api', write: (_level, line) => lines.push(line), now: () => new Date() });
    const meetingId = await videoMeeting(mp4(3000));
    const { body } = await issue('attendee', meetingId);
    const ticket = body.ticket!;
    const [, payload, mac] = ticket.split('.') as [string, string, string];
    const bad = `${ticket.slice(0, -2)}AA`;
    for (const t of [ticket, bad, 'garbage']) {
      const res = await stream(meetingId, t, { headers: { range: 'bytes=0-9' } });
      await res.arrayBuffer();
    }
    const missing = await stream(randomUUID(), ticket);
    await missing.arrayBuffer();
    restoreLogs?.();
    restoreLogs = null;
    const printed = lines.join('\n');
    expect(lines.filter((l) => l.includes('"msg":"request"')).length).toBeGreaterThanOrEqual(4);
    expect(printed).toContain('/api/meetings/:id/video/stream');
    for (const secret of [ticket, bad, payload, mac, 'ticket=', '?ticket', 'garbage']) expect(printed, secret).not.toContain(secret);
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
// Ludy Desktop's token over HTTP, on a real database (ADR-0055 slice 2, issue #4515): the shell signs in the way the extension does (a
// one-time PKCE code, an opaque `crx_` token) but its token is marked `desktop` by the server, holds no scope yet, is listed next to the
// extension's devices, is revoked the same way and is refused at once, and reaches /api/extension/me alone. The extension's own
// behavior is in extension-token.db.test.ts and the invariants in test/invariant/extension-*.test.ts.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { DESKTOP_CLIENT_ID } from '@ludy/kernel-contract';
import { kernelCommands, kernelQueries } from '@ludy/kernel';
import { BlobNotFoundError, BlobTooLargeError, DomainError, Runtime, sha256Hex, type BlobRef, type BlobStore, type CredentialBroker, type DirectTransfers } from '@ludy/kernel-runtime';
import { meetingsCommands, meetingsQueries } from '@ludy/mod-meetings';
import { actorOf, createAuthenticator } from '../src/auth.ts';
import { verifyExtensionBearer } from '../src/auth-extension.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { fakeMediaMeasurer } from './fake-media.ts';
import { RateLimiter } from '../src/rate-limit.ts';
import { createSessionStatusSource } from '../src/sessions.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const SECRET = 'test-only-desktop-secret-0123456789-abcdef';
const ISSUER = 'crove-auth-desktop';
const suite = ADMIN ? describe : describe.skip;

class MemoryStore implements BlobStore {
  readonly storage = new Map<string, Uint8Array>();
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
    this.storage.delete(key);
  }
}

class DirectMemoryStore extends MemoryStore {
  readonly direct: DirectTransfers = {
    presignUpload: async (key, maxBytes) => ({ url: 'memory://bucket', fields: { key }, expiresAt: new Date(Date.now() + 300_000), maxBytes }),
    presignDownload: async (_ref: BlobRef) => null,
    readStaged: async (key, maxBytes) => {
      const bytes = await this.get(key);
      if (bytes.byteLength > maxBytes) throw new BlobTooLargeError(key, maxBytes);
      return { bytes, sha256: sha256Hex(bytes) };
    },
  };
}

const EXT_ID = 'a'.repeat(32);
const challengeOf = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');
const webm = () => new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0xf7, 0x81, ...Array.from({ length: 64 }, (_, i) => i)]);

suite('Ludy Desktop token over HTTP (#4515, ADR-0055 slice 2 & slice 3 #4516)', () => {
  const dbName = `crove_test_desktop_http_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrlString = '';
  let pool: pg.Pool;
  let app: ReturnType<typeof createHttpApp>;
  let db: ReturnType<typeof createDb>;
  let runtime: Runtime;
  let broker: CredentialBroker;
  const accounts = new Map<string, { subject: string; email: string; session: string }>();
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

  async function jwt(name: string, mfa = false) {
    let who = accounts.get(name);
    if (!who) {
      who = { subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@desktop-http.test`, session: randomUUID() };
      accounts.set(name, who);
    }
    const now = Math.floor(Date.now() / 1000);
    const assurance = mfa ? { aal: 'aal2', amr: [{ method: 'totp', timestamp: now }] } : { aal: 'aal1' };
    return new SignJWT({ role: 'authenticated', email: who.email, session_id: who.session, is_anonymous: false, ...assurance })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(who.subject)
      .setIssuer(ISSUER)
      .setAudience('authenticated')
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(new TextEncoder().encode(SECRET));
  }

  const asBrowser = async (name: string, org: string | null = slug, mfa = false) => ({ authorization: `Bearer ${await jwt(name, mfa)}`, 'content-type': 'application/json', ...(org ? { 'x-crove-org': org } : {}) });
  const asToken = (token: string) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });

  async function rpc(path: string, headers: Record<string, string>, input: unknown, targetApp = app) {
    const response = await targetApp.request(`/api/rpc/${path}`, { method: 'POST', headers, body: JSON.stringify(input === undefined ? {} : { json: input }) });
    const body = (await response.json()) as { json?: unknown };
    return { status: response.status, body: (body.json ?? body) as Record<string, unknown> & unknown[] };
  }

  // The member approves in the app: Ludy Desktop's id with allowed scopes (when enabled), or any id and scopes for the extension.
  async function authorize(name: string, extensionId: string, scopes: string[], targetApp = app) {
    const verifier = randomBytes(32).toString('base64url');
    const response = await targetApp.request('/api/extension/authorize', {
      method: 'POST',
      headers: await asBrowser(name),
      body: JSON.stringify({ extensionId, codeChallenge: challengeOf(verifier), codeChallengeMethod: 'S256', scopes, deviceName: 'Ludy Desktop, Windows' }),
    });
    const body = (await response.json()) as { code?: string; codeError?: string; details?: Record<string, unknown> };
    return { verifier, status: response.status, code: body.code ?? '', body };
  }

  // The desktop shell trades its code: no Origin at all, and it says who it is. `origin` and `client` let a test play another caller.
  async function exchange(code: string, codeVerifier: string, over: { origin?: string; client?: string | null } = {}, targetApp = app) {
    const client = over.client === undefined ? 'desktop' : over.client;
    const response = await targetApp.request('/api/extension/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(over.origin ? { origin: over.origin } : {}) },
      body: JSON.stringify({ code, codeVerifier, ...(client === null ? {} : { client }) }),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  async function desktopSignIn(name: string, scopes: string[] = [], targetApp = app) {
    const issued = await authorize(name, DESKTOP_CLIENT_ID, scopes, targetApp);
    expect(issued.status).toBe(200);
    const done = await exchange(issued.code, issued.verifier, {}, targetApp);
    expect(done.status).toBe(200);
    return done.body as { token: string; tokenId: string; orgId: string; scopes: string[]; expiresAt: string };
  }

  async function extensionSignIn(name: string) {
    const issued = await authorize(name, EXT_ID, ['meetings']);
    expect(issued.status).toBe(200);
    const done = await exchange(issued.code, issued.verifier, { origin: `chrome-extension://${EXT_ID}`, client: null });
    expect(done.status).toBe(200);
    return done.body as { token: string; tokenId: string };
  }

  async function join(name: string, role: 'admin' | 'member' | 'viewer') {
    await jwt(name);
    const email = accounts.get(name)?.email;
    const invited = await rpc('org/invite', await asBrowser('owner', slug, true), { email, role });
    expect(invited.status).toBe(200);
    const accepted = await rpc('invites/accept', await asBrowser(name, null), { token: String(invited.body.acceptPath).split('#')[1] });
    expect(accepted.status).toBe(200);
  }

  function buildHttpApp(desktopCapture: 'on' | 'off', store: BlobStore = new MemoryStore()) {
    const config = loadConfig({
      DATABASE_URL: appUrlString,
      AUTH_JWT_SECRET: SECRET,
      AUTH_ISSUER: ISSUER,
      AUTH_SESSION_CHECK: 'off',
      MIGRATIONS_DIR: MIGRATIONS,
      WEB_DIST: '/nonexistent',
      EXTENSION_IDS: EXT_ID,
      MEETINGS_DESKTOP_CAPTURE: desktopCapture,
    });
    return createHttpApp({
      config,
      runtime,
      store,
      broker,
      authenticate: createAuthenticator(config, db),
      pool,
      aiEnabled: false,
      extensionTokenLimit: new RateLimiter({ perMinute: 200 }),
      mediaMeasurer: fakeMediaMeasurer(),
    });
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
    await setRolePasswords(adminUrl, { ludy_app: 'test-app-pw', ludy_worker: 'test-worker-pw' });
    const appUrl = new URL(adminUrl);
    appUrl.username = 'ludy_app';
    appUrl.password = 'test-app-pw';
    appUrlString = appUrl.toString();
    pool = createPool({ connectionString: appUrlString, max: 8 });
    db = createDb(pool);
    runtime = new Runtime(db, { manifests: TEST_MANIFESTS, sessions: createSessionStatusSource('off'), stepUp: 'required' }).register({
      commands: [...kernelCommands, ...meetingsCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...meetingsQueries],
    });
    broker = {
      keyId: 'k1-desktop-test',
      keyIds: ['k1-desktop-test'],
      derive: (purpose: string) => createHash('sha256').update(`test-secret:${purpose}`).digest(),
      deriveKey: (keyId: string, purpose: string) => createHash('sha256').update(`test-secret:${keyId}:${purpose}`).digest(),
    } as unknown as CredentialBroker;
    app = buildHttpApp('off');
    const created = await rpc('org/create', await asBrowser('owner', null), { name: `Desktop Org ${randomUUID().slice(0, 6)}`, idempotencyKey: randomUUID() });
    expect(created.status).toBe(200);
    slug = String(created.body.slug);
    orgId = String(created.body.orgId);
    await join('worker', 'member');
    await join('viewer', 'viewer');
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('signs Ludy Desktop in with no scope, marks the token desktop, audits the exchange and answers /api/extension/me', async () => {
    const done = await desktopSignIn('worker');
    expect(done.token).toMatch(/^crx_[A-Za-z0-9_-]{43}$/);
    expect(done.scopes).toEqual([]);
    expect(done.orgId).toBe(orgId);
    const row = await admin(async (c) => (await c.query<{ client: string; scopes: string[] }>('SELECT client, scopes FROM ludy_kernel.extension_token WHERE id = $1', [done.tokenId])).rows[0]);
    expect(row).toEqual({ client: 'desktop', scopes: [] });
    // The audit row is written by the exchange itself, as the member, ids only: the token and the code, never the code, the token or its hash.
    const audit = await admin(async (c) => (await c.query<{ actor_type: string; actor_id: string; target_id: string; detail: Record<string, unknown> }>(`SELECT actor_type, actor_id, target_id, detail FROM ludy_kernel.audit_event WHERE org_id = $1 AND command = 'kernel.extension.desktop.exchanged' AND outcome = 'ok'`, [orgId])).rows);
    const mine = audit.find((r) => r.target_id === done.tokenId);
    expect(mine?.actor_type).toBe('user');
    expect(mine?.detail).toMatchObject({ extensionToken: done.tokenId, client: 'desktop' });
    expect(JSON.stringify(mine?.detail)).not.toContain(done.token);
    const me = await app.request('/api/extension/me', { headers: asToken(done.token) });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ tokenId: done.tokenId, orgId, scopes: [], client: 'desktop', features: { meetings: false, agenda: false, notes: false } });
    // The extension's own token says so.
    const ext = await extensionSignIn('worker');
    expect(await (await app.request('/api/extension/me', { headers: asToken(ext.token) })).json()).toMatchObject({ client: 'extension', scopes: ['meetings'] });
  });

  it('puts the marker on ctx.actor.extension from the token row, never from the request', async () => {
    const done = await desktopSignIn('worker');
    const identity = await verifyExtensionBearer(db, done.token);
    expect(identity).toMatchObject({ tokenId: done.tokenId, scopes: [], client: 'desktop' });
    expect(actorOf({ userId: identity.userId, email: '', name: null, aal: 'aal1', sessionId: '', mfaAt: null, extension: identity }).extension).toEqual({ tokenId: done.tokenId, scopes: [], client: 'desktop' });
    const ext = await extensionSignIn('worker');
    expect((await verifyExtensionBearer(db, ext.token)).client).toBe('extension');
  });

  it('does not let a code made for the extension be exchanged as a desktop one, or the other way round', async () => {
    const forExtension = await authorize('worker', EXT_ID, ['meetings']);
    // As desktop (no Origin, client desktop): the code is bound to the extension id, so no row, one flat answer, and the code is not spent.
    const asDesktop = await exchange(forExtension.code, forExtension.verifier);
    expect(asDesktop.status).toBe(400);
    expect(asDesktop.body.code).toBe('EXTENSION_CODE_INVALID');
    expect((await exchange(forExtension.code, forExtension.verifier, { origin: `chrome-extension://${EXT_ID}`, client: null })).status).toBe(200);

    const forDesktop = await authorize('worker', DESKTOP_CLIENT_ID, []);
    // From the extension's Origin, with or without the desktop marker; from a page (any Origin) claiming to be desktop; naming the reserved id as an Origin.
    for (const attempt of [
      exchange(forDesktop.code, forDesktop.verifier, { origin: `chrome-extension://${EXT_ID}`, client: null }),
      exchange(forDesktop.code, forDesktop.verifier, { origin: `chrome-extension://${EXT_ID}` }),
      exchange(forDesktop.code, forDesktop.verifier, { origin: 'https://evil.example' }),
      exchange(forDesktop.code, forDesktop.verifier, { origin: `chrome-extension://${DESKTOP_CLIENT_ID}`, client: null }),
      exchange(forDesktop.code, forDesktop.verifier, { client: 'other' }),
      exchange(forDesktop.code, forDesktop.verifier, { client: null }),
    ]) {
      expect((await attempt).status).toBe(400);
    }
    // None of them spent it: the shell still gets its token.
    expect((await exchange(forDesktop.code, forDesktop.verifier)).status).toBe(200);
  });

  it('keeps the scope rules off by default while letting Postgres enforce desktop capture scopes (#4516)', async () => {
    const publicCfg = (await (await app.request('/api/config')).json()) as { meetingsDesktopCapture?: boolean };
    expect(publicCfg.meetingsDesktopCapture).toBe(false);
    const noScope = await authorize('worker', EXT_ID, []);
    expect(noScope.status).toBe(422);
    expect((await authorize('worker', 'b'.repeat(32), ['meetings'])).status).toBe(403);
    expect((await authorize('viewer', DESKTOP_CLIENT_ID, [])).status).toBe(403);
    // Off by default (MEETINGS_DESKTOP_CAPTURE=off): asking for meetings from Ludy Desktop is refused with 403 at authorize, and notes stays 422 in the contract.
    const captureOff = await authorize('worker', DESKTOP_CLIENT_ID, ['meetings']);
    expect(captureOff.status).toBe(403);
    expect(captureOff.body).toMatchObject({ code: 'FORBIDDEN' });
    expect((await authorize('worker', DESKTOP_CLIENT_ID, ['notes'])).status).toBe(422);
    // The tables enforce the slice 3 CHECK constraints: desktop may hold [], ['meetings'], or ['meetings', 'agenda'], never ['notes']; extension always requires >= 1 scope.
    const bad = async (sqlText: string, params: unknown[]) => admin((c) => c.query(sqlText, params).then(() => 'inserted', () => 'refused'));
    const member = await admin(async (c) => (await c.query<{ user_id: string }>(`SELECT user_id FROM ludy_kernel.tenant_member WHERE org_id = $1 LIMIT 1`, [orgId])).rows[0]?.user_id);
    const tokenSql = `INSERT INTO ludy_kernel.extension_token (org_id, user_id, token_hash, device_name, scopes, created_at, expires_at, created_by, client) VALUES ($1, $2, $3, 'x', ARRAY[]::text[], now(), now() + interval '1 day', $2, $4)`;
    expect(await bad(tokenSql, [orgId, member, createHash('sha256').update(randomUUID()).digest(), 'extension'])).toBe('refused');
    expect(await bad(tokenSql, [orgId, member, createHash('sha256').update(randomUUID()).digest(), 'tablet'])).toBe('refused');
    const withMeetings = tokenSql.replace('ARRAY[]::text[]', "ARRAY['meetings']::text[]");
    const withNotes = tokenSql.replace('ARRAY[]::text[]', "ARRAY['notes']::text[]");
    const withMeetingsNotes = tokenSql.replace('ARRAY[]::text[]', "ARRAY['meetings', 'notes']::text[]");
    expect(await bad(withMeetings, [orgId, member, createHash('sha256').update(randomUUID()).digest(), 'desktop'])).toBe('inserted');
    expect(await bad(withNotes, [orgId, member, createHash('sha256').update(randomUUID()).digest(), 'desktop'])).toBe('refused');
    expect(await bad(withMeetingsNotes, [orgId, member, createHash('sha256').update(randomUUID()).digest(), 'desktop'])).toBe('refused');
    expect(await bad(withMeetings, [orgId, member, createHash('sha256').update(randomUUID()).digest(), 'extension'])).toBe('inserted');
    expect(await bad(tokenSql, [orgId, member, createHash('sha256').update(randomUUID()).digest(), 'desktop'])).toBe('inserted');

    // Even if a desktop token row already holds meetings in SQL while MEETINGS_DESKTOP_CAPTURE=off, /api/extension/me strips scopes and every capture route refuses 403.
    const rawToken = `crx_${randomBytes(32).toString('base64url')}`;
    await admin((c) => c.query(withMeetings, [orgId, member, createHash('sha256').update(rawToken).digest(), 'desktop']));
    const meOff = await app.request('/api/extension/me', { headers: asToken(rawToken) });
    expect(meOff.status).toBe(200);
    expect(await meOff.json()).toMatchObject({ client: 'desktop', scopes: [], features: { meetings: false, agenda: false, notes: false } });
    expect((await rpc('meetings/create', asToken(rawToken), { title: 'Blocked', consentMethod: 'told_at_start', visibility: 'attendees', keepVideo: false })).status).toBe(403);
  });

  it('refuses a zero-scope desktop token on every route but /api/extension/me, at the edge and in the runtime', async () => {
    const { token, tokenId } = await desktopSignIn('worker');
    expect((await app.request('/api/extension/me', { headers: asToken(token) })).status).toBe(200);
    const routes: Array<[string, string]> = [
      ['POST', '/api/rpc/meetings/create'],
      ['POST', '/api/rpc/meetings/captureHeartbeat'],
      ['POST', '/api/rpc/meetings/agenda/next'],
      ['POST', '/api/rpc/notes/clip'],
      ['POST', '/api/rpc/notes/todos/quickCapture'],
      ['POST', '/api/files/uploads'],
      ['POST', `/api/meetings/${randomUUID()}/media`],
      ['POST', `/api/meetings/${randomUUID()}/live-chunk`],
      ['POST', '/api/rpc/extension/tokens/list'],
      ['POST', '/api/rpc/extension/tokens/revoke'],
      ['POST', '/api/extension/authorize'],
      ['POST', '/api/rpc/org/create'],
      ['GET', '/api/rpc/me/get'],
    ];
    for (const [method, path] of routes) {
      const response = await app.request(path, { method, headers: asToken(token), ...(method === 'POST' ? { body: '{}' } : {}) });
      expect(response.status, `${method} ${path}`).toBe(403);
      expect(((await response.json()) as { code?: string }).code, `${method} ${path}`).toBe('FORBIDDEN');
    }
    // Past the edge, the runtime holds the same line: no command or query declares an access a scope-less token has.
    const identity = await verifyExtensionBearer(db, token);
    const actor = actorOf({ userId: identity.userId, email: '', name: null, aal: 'aal1', sessionId: '', mfaAt: null, extension: identity });
    for (const call of [
      () => runtime.query('kernel.extension.token.list', {}, { actor, orgId }),
      () => runtime.execute('kernel.extension.token.revoke', { tokenId }, { actor, orgId }),
      () => runtime.execute('meetings.meeting.create', {}, { actor, orgId }),
    ]) {
      const error = await call().then(() => null, (e: unknown) => e);
      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError).details?.rule === 'extension_scope' || (error as DomainError).code === 'VALIDATION').toBe(true);
    }
  });

  it('lists the desktop device next to the extension\'s, and revoking it refuses the token at once, like an extension token', async () => {
    const desktop = await desktopSignIn('worker');
    const ext = await extensionSignIn('worker');
    const listed = await rpc('extension/tokens/list', await asBrowser('worker'), {});
    expect(listed.status).toBe(200);
    const rows = listed.body as unknown as Array<{ id: string; client: string; scopes: string[]; deviceName: string; lastUsedAt: string | null; revokedAt: string | null }>;
    expect(rows.find((r) => r.id === desktop.tokenId)).toMatchObject({ client: 'desktop', scopes: [], deviceName: 'Ludy Desktop, Windows', revokedAt: null });
    expect(rows.find((r) => r.id === ext.tokenId)).toMatchObject({ client: 'extension', scopes: ['meetings'] });
    // The owner sees both in the org's list, marked.
    const org = await rpc('extension/tokens/listOrg', await asBrowser('owner'), {});
    const orgRows = org.body as unknown as Array<{ id: string; client: string }>;
    expect(orgRows.find((r) => r.id === desktop.tokenId)?.client).toBe('desktop');
    expect(orgRows.find((r) => r.id === ext.tokenId)?.client).toBe('extension');
    // The desktop token was used (the /me above did not run for this one, so make one call): its last use shows.
    expect((await app.request('/api/extension/me', { headers: asToken(desktop.token) })).status).toBe(200);
    const used = (await rpc('extension/tokens/list', await asBrowser('worker'), {})).body as unknown as Array<{ id: string; lastUsedAt: string | null }>;
    expect(used.find((r) => r.id === desktop.tokenId)?.lastUsedAt).not.toBeNull();

    // Revoke from the screen: the next call of the shell is 401 EXTENSION_TOKEN_INVALID, the extension's token is untouched.
    expect((await rpc('extension/tokens/revoke', await asBrowser('worker'), { tokenId: desktop.tokenId })).status).toBe(200);
    const after = await app.request('/api/extension/me', { headers: asToken(desktop.token) });
    expect(after.status).toBe(401);
    expect(((await after.json()) as { code?: string }).code).toBe('EXTENSION_TOKEN_INVALID');
    expect((await app.request('/api/extension/me', { headers: asToken(ext.token) })).status).toBe(200);
    // The same answer at the database: verify_extension_token, as the API's own login, finds no row for either kind once revoked.
    const verify = async (token: string) =>
      pool.query(`SELECT * FROM ludy_kernel.verify_extension_token($1::bytea, NULL::text)`, [createHash('sha256').update(token).digest()]).then((r) => r.rows);
    expect(await verify(desktop.token)).toEqual([]);
    expect((await verify(ext.token)).length).toBe(1);
    expect((await rpc('extension/tokens/revoke', await asBrowser('worker'), { tokenId: ext.tokenId })).status).toBe(200);
    expect(await verify(ext.token)).toEqual([]);
  });

  it('refuses a desktop token past its end', async () => {
    const gone = await desktopSignIn('worker');
    await admin((c) => c.query(`UPDATE ludy_kernel.extension_token SET expires_at = now() - interval '1 second', created_at = now() - interval '2 days' WHERE id = $1`, [gone.tokenId]));
    expect((await app.request('/api/extension/me', { headers: asToken(gone.token) })).status).toBe(401);
  });

  it('lets a scoped desktop token open a desktop capture, heartbeat, upload media and stream live chunks when MEETINGS_DESKTOP_CAPTURE=on (#4516)', async () => {
    const store = new DirectMemoryStore();
    const captureApp = buildHttpApp('on', store);
    const publicCfg = (await (await captureApp.request('/api/config')).json()) as { meetingsDesktopCapture?: boolean };
    expect(publicCfg.meetingsDesktopCapture).toBe(true);

    // A zero-scope desktop token still reaches /api/extension/me alone even when MEETINGS_DESKTOP_CAPTURE=on.
    const bare = await desktopSignIn('worker', [], captureApp);
    expect(bare.scopes).toEqual([]);
    expect(await (await captureApp.request('/api/extension/me', { headers: asToken(bare.token) })).json()).toMatchObject({
      client: 'desktop',
      scopes: [],
      features: { meetings: false, agenda: false, notes: false },
    });
    expect((await rpc('meetings/create', asToken(bare.token), { title: 'Bare', consentMethod: 'told_at_start', visibility: 'attendees', keepVideo: false }, captureApp)).status).toBe(403);

    // Scoped desktop token: meetings + agenda allowed, notes still refused.
    expect((await authorize('worker', DESKTOP_CLIENT_ID, ['notes'], captureApp)).status).toBe(422);
    const scoped = await desktopSignIn('worker', ['meetings', 'agenda'], captureApp);
    expect(scoped.scopes).toEqual(['agenda', 'meetings']);
    expect(await (await captureApp.request('/api/extension/me', { headers: asToken(scoped.token) })).json()).toMatchObject({
      tokenId: scoped.tokenId,
      client: 'desktop',
      scopes: ['agenda', 'meetings'],
      features: { meetings: true, agenda: true, notes: false },
    });

    // meetings.meeting.create creates capture_session with kind = 'desktop' and audits capture: 'desktop'.
    const created = await rpc(
      'meetings/create',
      asToken(scoped.token),
      { title: 'Desktop Call', consentMethod: 'told_at_start', visibility: 'attendees', keepVideo: false, liveNotes: true },
      captureApp,
    );
    expect(created.status).toBe(200);
    const meetingId = String(created.body.meetingId);
    const sessions = await admin(async (c) =>
      (await c.query<{ kind: string; ended_reason: string | null }>('SELECT kind, ended_reason FROM ludy_meetings.capture_session WHERE meeting_id = $1', [meetingId])).rows,
    );
    expect(sessions).toEqual([{ kind: 'desktop', ended_reason: null }]);

    // Heartbeat, status, and live-chunk work on the meeting this desktop token created.
    expect(await rpc('meetings/captureHeartbeat', asToken(scoped.token), { meetingId }, captureApp)).toMatchObject({ status: 200, body: { open: true } });
    expect(await rpc('meetings/extensionStatus', asToken(scoped.token), { meetingId }, captureApp)).toMatchObject({ status: 200, body: { hasAudio: false, liveNotes: true } });
    const chunkBytes = webm();
    const liveRes = await captureApp.request(`/api/meetings/${meetingId}/live-chunk?seq=0&lengthSeconds=15`, {
      method: 'POST',
      headers: { authorization: `Bearer ${scoped.token}`, 'content-type': 'audio/webm', 'content-length': String(chunkBytes.byteLength) },
      body: chunkBytes,
    });
    expect(liveRes.status).toBe(200);

    // Live-chunk still enforces consent record on the server: missing notice version gets 409 CONSENT_MISSING.
    const noConsent = await rpc(
      'meetings/create',
      asToken(scoped.token),
      { title: 'Missing Consent', consentMethod: 'told_at_start', visibility: 'attendees', keepVideo: false, liveNotes: true },
      captureApp,
    );
    const noConsentId = String(noConsent.body.meetingId);
    await admin((c) => c.query(`UPDATE ludy_meetings.meeting SET consent_notice_version = '' WHERE id = $1`, [noConsentId]));
    const missingConsentChunk = await captureApp.request(`/api/meetings/${noConsentId}/live-chunk?seq=0&lengthSeconds=15`, {
      method: 'POST',
      headers: { authorization: `Bearer ${scoped.token}`, 'content-type': 'audio/webm', 'content-length': String(chunkBytes.byteLength) },
      body: chunkBytes,
    });
    expect(missingConsentChunk.status).toBe(409);
    expect(((await missingConsentChunk.json()) as { code?: string }).code).toBe('CONSENT_MISSING');

    // Staged upload grant + /api/meetings/:id/media works for meeting_audio and refuses document purpose.
    const docGrant = await captureApp.request('/api/files/uploads', { method: 'POST', headers: asToken(scoped.token), body: JSON.stringify({ purpose: 'document' }) });
    expect(docGrant.status).toBe(403);
    const grantRes = await captureApp.request('/api/files/uploads', { method: 'POST', headers: asToken(scoped.token), body: JSON.stringify({ purpose: 'meeting_audio' }) });
    expect(grantRes.status).toBe(200);
    const grant = (await grantRes.json()) as { uploadId: string; fields: { key: string } };
    await store.put(grant.fields.key, chunkBytes);
    const finalize = await captureApp.request(`/api/meetings/${meetingId}/media`, {
      method: 'POST',
      headers: asToken(scoped.token),
      body: JSON.stringify({ uploadId: grant.uploadId, kind: 'audio', lengthSeconds: 60 }),
    });
    expect(finalize.status).toBe(200);
    const ended = await admin(async (c) =>
      (await c.query<{ kind: string; ended_reason: string | null }>('SELECT kind, ended_reason FROM ludy_meetings.capture_session WHERE meeting_id = $1', [meetingId])).rows,
    );
    expect(ended).toEqual([{ kind: 'desktop', ended_reason: 'media' }]);

    // recordingStopped works on a desktop meeting with no media, ending the capture cleanly.
    expect(await rpc('meetings/recordingStopped', asToken(scoped.token), { meetingId: noConsentId, reason: 'unknown', lengthSeconds: 0 }, captureApp)).toMatchObject({ status: 200 });
    const stoppedSession = await admin(async (c) =>
      (await c.query<{ ended_reason: string | null }>('SELECT ended_reason FROM ludy_meetings.capture_session WHERE meeting_id = $1', [noConsentId])).rows[0],
    );
    expect(stoppedSession?.ended_reason).toBe('stopped');

    // Out-of-scope routes stay forbidden (notes, read routes, and other meetings stay isolated).
    expect((await rpc('meetings/agenda/next', asToken(scoped.token), {}, captureApp)).status).toBe(200);
    expect((await rpc('notes/clip', asToken(scoped.token), { text: 'x' }, captureApp)).status).toBe(403);
    expect((await rpc('meetings/get', asToken(scoped.token), { meetingId }, captureApp)).status).toBe(403);
    expect((await captureApp.request(`/api/meetings/${meetingId}/audio`, { headers: asToken(scoped.token) })).status).toBe(403);
  });
});

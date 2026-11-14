// SPDX-License-Identifier: AGPL-3.0-only
// The Ludy extension's sign-in and its token over HTTP, on a real database (issue #2582, ADR-0047 point 10): the member
// approves the extension in the app, the extension trades its one-time code with PKCE for a token and records a meeting
// with it; the token is refused outside its scopes, a wrong or replayed code gets one flat 400, and a device the member
// disconnects is refused at once. The invariants (scope, standing, audit) are in test/invariant/extension-*.test.ts.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { DEFAULT_EXTENSION_IDS } from '@crove/kernel-contract';
import { kernelCommands, kernelQueries } from '@crove/kernel';
import { BlobNotFoundError, DomainError, Runtime, sha256Hex, type BlobStore, type CredentialBroker } from '@crove/kernel-runtime';
import { financeCommands, financeQueries } from '@crove/mod-finance';
import { meetingsCommands, meetingsQueries } from '@crove/mod-meetings';
import { createAuthenticator } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { fakeMediaMeasurer } from './fake-media.ts';
import { RateLimiter } from '../src/rate-limit.ts';
import { createSessionStatusSource } from '../src/sessions.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const SECRET = 'test-only-extension-secret-0123456789-abcdef';
const ISSUER = 'crove-auth-extension';
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

const EXT_ID = 'a'.repeat(32); // the id this test's deployment lists in EXTENSION_IDS
const OTHER_EXT_ID = 'b'.repeat(32);
const STORE_EXT_ID = 'emfhpcbmdbbeomfkdadbellllngmlhmf'; // the Chrome Web Store build (#3010)
const challengeOf = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');
const webm = () => new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, ...Array.from({ length: 64 }, (_, i) => i)]);

suite('the Ludy extension token over HTTP (#2582, ADR-0047 point 10)', () => {
  const dbName = `crove_test_ext_http_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let app: ReturnType<typeof createHttpApp>;
  const store = new MemoryStore();
  const accounts = new Map<string, { subject: string; email: string; session: string }>();
  let slug = '';
  let orgId = '';
  let appUrlText = '';
  let sharedDb: ReturnType<typeof createDb>;
  let sharedConfig: ReturnType<typeof loadConfig>;
  let sharedBroker: CredentialBroker;
  let sharedRuntime: Runtime;

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
      who = { subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@ext-http.test`, session: randomUUID() };
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

  async function rpc(path: string, headers: Record<string, string>, input: unknown) {
    const response = await app.request(`/api/rpc/${path}`, { method: 'POST', headers, body: JSON.stringify(input === undefined ? {} : { json: input }) });
    const body = (await response.json()) as { json?: Record<string, unknown> };
    return { status: response.status, body: (body.json ?? body) as Record<string, unknown> };
  }

  // The whole sign-in: the member approves in the app (PKCE challenge in), the extension trades the code and verifier.
  async function connect(name: string, org = slug, scopes: string[] = ['meetings'], extensionId = EXT_ID) {
    const verifier = randomBytes(32).toString('base64url');
    const authorize = await app.request('/api/extension/authorize', {
      method: 'POST',
      headers: await asBrowser(name, org),
      body: JSON.stringify({ extensionId, codeChallenge: challengeOf(verifier), codeChallengeMethod: 'S256', scopes, deviceName: 'Chrome trên máy bàn' }),
    });
    const issued = (await authorize.json()) as { code?: string };
    return { verifier, status: authorize.status, code: issued.code ?? '' };
  }

  // The extension trades its code from its own origin: the browser sends chrome-extension://<id> (#2850).
  const originOf = (id: string) => `chrome-extension://${id}`;
  async function exchange(code: string, codeVerifier: string, origin: string | null = originOf(EXT_ID), target = app) {
    const response = await target.request('/api/extension/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(origin === null ? {} : { origin }) },
      body: JSON.stringify({ code, codeVerifier }),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  async function signedIn(name: string) {
    const first = await connect(name);
    expect(first.status).toBe(200);
    const done = await exchange(first.code, first.verifier);
    expect(done.status).toBe(200);
    return done.body as { token: string; tokenId: string; orgId: string; scopes: string[]; expiresAt: string };
  }

  async function join(name: string, role: 'admin' | 'member' | 'viewer') {
    await jwt(name);
    const email = accounts.get(name)?.email;
    const invited = await rpc('org/invite', await asBrowser('owner', slug, true), { email, role });
    expect(invited.status).toBe(200);
    // Inviting is a step-up command, so the owner signs that call with a fresh second factor; the accept link carries the token after '#'.
    const accepted = await rpc('invites/accept', await asBrowser(name, null), { token: String(invited.body.acceptPath).split('#')[1] });
    expect(accepted.status).toBe(200);
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
    const appUrl = new URL(adminUrl);
    appUrl.username = 'crove_app';
    appUrl.password = 'test-app-pw';
    appUrlText = appUrl.toString();
    pool = createPool({ connectionString: appUrl.toString(), max: 8 });
    const db = createDb(pool);
    sharedDb = db;
    const config = loadConfig({ DATABASE_URL: appUrl.toString(), AUTH_JWT_SECRET: SECRET, AUTH_ISSUER: ISSUER, AUTH_SESSION_CHECK: 'off', MIGRATIONS_DIR: MIGRATIONS, WEB_DIST: '/nonexistent', EXTENSION_IDS: EXT_ID });
    sharedConfig = config;
    const runtime = new Runtime(db, { manifests: TEST_MANIFESTS, sessions: createSessionStatusSource('off'), stepUp: 'required' }).register({
      commands: [...kernelCommands, ...financeCommands, ...meetingsCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries, ...meetingsQueries],
    });
    const broker = {
      keyId: 'k1-ext-test',
      keyIds: ['k1-ext-test'],
      derive: (purpose: string) => createHash('sha256').update(`test-secret:${purpose}`).digest(),
      deriveKey: (keyId: string, purpose: string) => createHash('sha256').update(`test-secret:${keyId}:${purpose}`).digest(),
    } as unknown as CredentialBroker;
    sharedBroker = broker;
    sharedRuntime = runtime;
    app = createHttpApp({
      config,
      runtime,
      store,
      broker,
      authenticate: createAuthenticator(config, db),
      pool,
      aiEnabled: false,
      // A budget the test can spend: the default is a person's few sign-ins a minute.
      extensionTokenLimit: new RateLimiter({ perMinute: 40 }),
      mediaMeasurer: fakeMediaMeasurer(),
    });
    const created = await rpc('org/create', await asBrowser('owner', null), { name: `Extension Org ${randomUUID().slice(0, 6)}`, idempotencyKey: randomUUID() });
    expect(created.status).toBe(200);
    slug = String(created.body.slug);
    orgId = String(created.body.orgId);
    await join('recorder', 'member');
    await join('viewer', 'viewer');
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('signs the extension in with a one-time PKCE code, once, and says nothing else on a refusal', async () => {
    const first = await connect('recorder');
    expect(first.status).toBe(200);
    expect(first.code).toMatch(/^crc_[A-Za-z0-9_-]{43}$/);
    // Only the code's hash is stored, never the code, and the challenge, scopes and device name come with it.
    const stored = await admin(async (c) => (await c.query<{ code_hash: Buffer; device_name: string; scopes: string[] }>('SELECT code_hash, device_name, scopes FROM crove_kernel.extension_auth_code WHERE org_id = $1', [orgId])).rows);
    expect(stored.some((r) => r.code_hash.equals(createHash('sha256').update(first.code).digest()))).toBe(true);
    expect(JSON.stringify(stored)).not.toContain(first.code);
    // A wrong verifier, a malformed code, an unknown code: the same 400 and body.
    const wrong = await exchange(first.code, randomBytes(32).toString('base64url'));
    const malformed = await exchange('not-a-code', first.verifier);
    const unknown = await exchange(`crc_${randomBytes(32).toString('base64url')}`, first.verifier);
    expect([wrong.status, malformed.status, unknown.status]).toEqual([400, 400, 400]);
    expect(wrong.body).toEqual(malformed.body);
    expect(wrong.body).toEqual(unknown.body);
    expect(JSON.stringify(wrong.body)).not.toContain(orgId);
    // The right verifier still works after the wrong one, once; its replay is the same flat refusal.
    const done = await exchange(first.code, first.verifier);
    expect(done.status).toBe(200);
    expect(done.body.token).toMatch(/^crx_[A-Za-z0-9_-]{43}$/);
    expect(done.body.orgId).toBe(orgId);
    expect(done.body.scopes).toEqual(['meetings']);
    const days = (new Date(String(done.body.expiresAt)).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(89.9);
    expect(days).toBeLessThanOrEqual(90);
    expect(await exchange(first.code, first.verifier)).toEqual({ status: 400, body: wrong.body });
    // The exchange is audited, ids only: the member, the token that did it, the code it came from.
    const audit = await admin(async (c) => (await c.query<{ actor_id: string; detail: Record<string, unknown> }>(`SELECT actor_id, detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'kernel.extension.token.exchanged' AND outcome = 'ok'`, [orgId])).rows);
    const mine = audit.find((r) => r.detail.extensionToken === done.body.tokenId);
    expect(mine?.detail.codeId).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(mine?.detail)).not.toContain(first.code);
    // The token is stored as its hash only.
    const hashes = await admin(async (c) => (await c.query<{ token_hash: Buffer }>('SELECT token_hash FROM crove_kernel.extension_token WHERE org_id = $1', [orgId])).rows);
    expect(hashes.some((r) => r.token_hash.equals(createHash('sha256').update(String(done.body.token)).digest()))).toBe(true);
  });

  it('binds a code to the extension it was issued for: another id, a wrong or missing Origin, or a code made without an id cannot exchange it (#2850)', async () => {
    // A deployment that lists two extensions (the store's and a development one): the code of one must not work from the other.
    const both = loadConfig({ DATABASE_URL: appUrlText, AUTH_JWT_SECRET: SECRET, AUTH_ISSUER: ISSUER, AUTH_SESSION_CHECK: 'off', MIGRATIONS_DIR: MIGRATIONS, WEB_DIST: '/nonexistent', EXTENSION_IDS: `${EXT_ID}, ${OTHER_EXT_ID}` });
    const twoIds = createHttpApp({ config: both, runtime: sharedRuntime, store, broker: sharedBroker, authenticate: createAuthenticator(both, sharedDb), pool, aiEnabled: false, extensionTokenLimit: new RateLimiter({ perMinute: 40 }) });
    const issue = async (id: string) => {
      const verifier = randomBytes(32).toString('base64url');
      const response = await twoIds.request('/api/extension/authorize', {
        method: 'POST',
        headers: await asBrowser('recorder'),
        body: JSON.stringify({ extensionId: id, codeChallenge: challengeOf(verifier), codeChallengeMethod: 'S256', scopes: ['meetings'], deviceName: 'Chrome' }),
      });
      expect(response.status).toBe(200);
      return { verifier, code: ((await response.json()) as { code: string }).code };
    };
    const a = await issue(EXT_ID);
    // The id is stored with the code.
    const bound = await admin(async (c) => (await c.query<{ extension_id: string | null }>('SELECT extension_id FROM crove_kernel.extension_auth_code WHERE code_hash = $1', [createHash('sha256').update(a.code).digest()])).rows[0]?.extension_id);
    expect(bound).toBe(EXT_ID);
    // Every refusal is the same flat 400, and none spends the code.
    const refusals = [
      await exchange(a.code, a.verifier, originOf(OTHER_EXT_ID), twoIds), // a listed id, but not the code's
      await exchange(a.code, a.verifier, null, twoIds), // no Origin
      await exchange(a.code, a.verifier, originOf('c'.repeat(32)), twoIds), // an id the deployment does not list
      await exchange(a.code, a.verifier, `${originOf(EXT_ID)}/`, twoIds), // not exactly chrome-extension://<id>
      await exchange(a.code, a.verifier, `https://${EXT_ID}.chromiumapp.org`, twoIds), // a web origin
      await exchange(a.code, a.verifier, 'null', twoIds),
    ];
    for (const refused of refusals) expect(refused.status).toBe(400);
    for (const refused of refusals) expect(refused.body).toEqual(refusals[0]!.body);
    const unspent = await admin(async (c) => (await c.query<{ consumed_at: Date | null; failed_attempts: number }>('SELECT consumed_at, failed_attempts FROM crove_kernel.extension_auth_code WHERE code_hash = $1', [createHash('sha256').update(a.code).digest()])).rows[0]);
    expect(unspent).toEqual({ consumed_at: null, failed_attempts: 0 });
    // The code's own extension still gets its token, once.
    const done = await exchange(a.code, a.verifier, originOf(EXT_ID), twoIds);
    expect(done.status).toBe(200);
    expect(done.body.token).toMatch(/^crx_/);
    // And the other way round: a code for B is for B alone.
    const b = await issue(OTHER_EXT_ID);
    expect((await exchange(b.code, b.verifier, originOf(EXT_ID), twoIds)).status).toBe(400);
    expect((await exchange(b.code, b.verifier, originOf(OTHER_EXT_ID), twoIds)).status).toBe(200);
    // An id taken off the allow-list after the code was issued no longer exchanges, even from its own origin.
    const c = await issue(OTHER_EXT_ID);
    expect((await exchange(c.code, c.verifier, originOf(OTHER_EXT_ID))).status).toBe(400);
    // A code with no bound id (a row from before the id was bound, written by the owner role: no definer makes one any more) is refused by the
    // route whatever the origin, and the command no longer takes an input without the id.
    const verifier = randomBytes(32).toString('base64url');
    const unboundCode = `crc_${randomBytes(32).toString('base64url')}`;
    await admin(async (c) =>
      c.query(
        `INSERT INTO crove_kernel.extension_auth_code (org_id, user_id, code_hash, code_challenge, code_challenge_method, scopes, device_name, created_at, expires_at)
         VALUES ($1, $2, $3, $4, 'S256', ARRAY['meetings'], 'Chrome', now(), now() + interval '5 minutes')`,
        [orgId, await userIdOf('recorder'), createHash('sha256').update(unboundCode).digest(), challengeOf(verifier)],
      ),
    );
    expect((await exchange(unboundCode, verifier, originOf(EXT_ID), twoIds)).status).toBe(400);
    expect((await exchange(unboundCode, verifier, originOf(OTHER_EXT_ID), twoIds)).status).toBe(400);
    const noId = await sharedRuntime
      .execute(
        'kernel.extension.code.issue',
        { codeHash: createHash('sha256').update(randomBytes(8)).digest('hex'), codeChallenge: challengeOf(verifier), scopes: ['meetings'], deviceName: 'Chrome' },
        { actor: { type: 'user', userId: await userIdOf('recorder'), aal: 'aal1', sessionId: randomUUID(), mfaAt: null }, orgId },
      )
      .then(() => 'accepted', (error: unknown) => (error as { code?: string }).code);
    expect(noId).toBe('VALIDATION');
  });

  it('counts a token\'s requests per client even when the header has extra spaces', async () => {
    const flood = createHttpApp({
      config: loadConfig({ DATABASE_URL: 'postgres://localhost/x', AUTH_JWT_SECRET: SECRET, AUTH_ISSUER: ISSUER, AUTH_SESSION_CHECK: 'off', MIGRATIONS_DIR: MIGRATIONS, WEB_DIST: '/nonexistent' }),
      runtime: { installed: () => true, modules: () => [] } as unknown as Runtime,
      store,
      authenticate: async () => {
        throw new DomainError('EXTENSION_TOKEN_INVALID', 401, 'no');
      },
      pool,
      aiEnabled: false,
      extensionBearerLimit: new RateLimiter({ perMinute: 2 }),
    });
    const probe = (header: string) => flood.request('/api/extension/me', { headers: { authorization: header } });
    const token = `crx_${'A'.repeat(43)}`;
    expect([(await probe(`Bearer ${token}`)).status, (await probe(`Bearer   ${token}`)).status, (await probe(`Bearer ${token} `)).status]).toEqual([401, 401, 429]);
  });

  it('refuses a viewer, an unsigned request and an extension token on the sign-in route', async () => {
    expect((await connect('viewer')).status).toBe(403);
    const anonymous = await app.request('/api/extension/authorize', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(anonymous.status).toBe(401);
    const { token } = await signedIn('recorder');
    const byToken = await app.request('/api/extension/authorize', { method: 'POST', headers: { ...asToken(token), 'x-crove-org': slug }, body: JSON.stringify({ codeChallenge: challengeOf('v'.repeat(43)), codeChallengeMethod: 'S256', scopes: ['meetings'], deviceName: 'x' }) });
    expect(byToken.status).toBe(403);
    const badShape = await app.request('/api/extension/authorize', { method: 'POST', headers: await asBrowser('recorder'), body: JSON.stringify({ codeChallenge: 'short', codeChallengeMethod: 'S256', scopes: ['meetings'], deviceName: 'x' }) });
    expect(badShape.status).toBe(422);
    const noScope = await app.request('/api/extension/authorize', { method: 'POST', headers: await asBrowser('recorder'), body: JSON.stringify({ codeChallenge: challengeOf('v'.repeat(43)), codeChallengeMethod: 'S256', scopes: ['crm'], deviceName: 'x' }) });
    expect(noScope.status).toBe(422);
  });

  it('runs the meetings scope end to end as the member, and cannot read what it recorded', async () => {
    const { token, scopes } = await signedIn('recorder');
    expect(scopes).toEqual(['meetings']);
    const me = await app.request('/api/extension/me', { headers: asToken(token) });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ orgId, scopes: ['meetings'], features: { meetings: true } });
    const created = await rpc('meetings/create', asToken(token), { title: 'Họp với khách', consentMethod: 'told_at_start', visibility: 'attendees', keepVideo: false });
    expect(created.status).toBe(200);
    const meetingId = String(created.body.meetingId);
    const status = await rpc('meetings/extensionStatus', asToken(token), { meetingId });
    expect(status).toMatchObject({ status: 200, body: { meetingId, status: 'ready', hasAudio: false, hasVideo: false } });
    expect(JSON.stringify(status.body)).not.toContain('Họp với khách');
    // The upload: a grant for the meeting's audio only, then the recording itself (multipart; no direct store here).
    const file = new FormData();
    file.set('kind', 'audio');
    file.set('file', new Blob([webm()], { type: 'audio/webm' }), 'rec.webm');
    file.set('lengthSeconds', '60');
    const upload = await app.request(`/api/meetings/${meetingId}/media`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'x-crove-org': slug }, body: file });
    expect(upload.status).toBe(200);
    expect(await rpc('meetings/extensionStatus', asToken(token), { meetingId })).toMatchObject({ body: { hasAudio: true } });
    // What it cannot do: read the meeting, its media or any file, list meetings or devices, take another purpose.
    const closed = [
      await rpc('meetings/get', asToken(token), { meetingId }),
      await rpc('meetings/list', asToken(token), {}),
      await rpc('extension/tokens/list', asToken(token), {}),
      await rpc('me/get', asToken(token), undefined),
    ];
    expect(closed.map((r) => r.status)).toEqual([403, 403, 403, 403]);
    for (const [method, path] of [
      ['GET', `/api/meetings/${meetingId}/audio`],
      ['GET', `/api/meetings/${meetingId}/video`],
      ['GET', `/api/files/${randomUUID()}`],
      ['POST', '/api/stream/tickets'],
      ['GET', '/api/org-export/x'],
    ] as const) {
      const refused = await app.request(path, { method, headers: { authorization: `Bearer ${token}`, 'x-crove-org': slug } });
      expect(refused.status, `${method} ${path}`).toBe(403);
    }
    const grantFor = (purpose: string) => app.request('/api/files/uploads', { method: 'POST', headers: asToken(token), body: JSON.stringify({ purpose }) });
    // (This store has no direct transfers, so a grant is 404 whatever its purpose; the grant's purpose rule is an invariant.)
    expect((await grantFor('document')).status).not.toBe(200);
    // The meeting's recorder reads it in the app as ever: the token changed nothing about their own access.
    const own = await rpc('meetings/get', await asBrowser('recorder'), { meetingId });
    expect(own.status).toBe(200);
    // A meeting made in the app is not the token's.
    const inApp = await rpc('meetings/create', await asBrowser('recorder'), { title: 'Trong ứng dụng', consentMethod: 'told_at_start', visibility: 'attendees', keepVideo: false });
    const foreign = await rpc('meetings/extensionStatus', asToken(token), { meetingId: String(inApp.body.meetingId) });
    expect(foreign.status).toBe(404);
    const foreignUpload = new FormData();
    foreignUpload.set('kind', 'audio');
    foreignUpload.set('file', new Blob([webm()], { type: 'audio/webm' }), 'rec.webm');
    const refused = await app.request(`/api/meetings/${String(inApp.body.meetingId)}/media`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: foreignUpload });
    expect(refused.status).toBe(404);
  });

  it('lists the member\'s devices without a hash and ends a disconnected device at once', async () => {
    const { token, tokenId } = await signedIn('recorder');
    const listed = await rpc('extension/tokens/list', await asBrowser('recorder'), {});
    expect(listed.status).toBe(200);
    expect(JSON.stringify(listed.body)).not.toMatch(/hash/i);
    expect(Object.values(listed.body).flat().length).toBeGreaterThan(0);
    // A member who is not the owner of the token cannot disconnect it; the owner of the device can.
    const others = await rpc('extension/tokens/revoke', await asBrowser('owner'), { tokenId });
    expect(others.status).toBe(404);
    expect((await app.request('/api/extension/me', { headers: asToken(token) })).status).toBe(200);
    const revoked = await rpc('extension/tokens/revoke', await asBrowser('recorder'), { tokenId });
    expect(revoked.status).toBe(200);
    for (const attempt of [
      app.request('/api/extension/me', { headers: asToken(token) }),
      app.request('/api/rpc/meetings/create', { method: 'POST', headers: asToken(token), body: JSON.stringify({ json: { title: 'x', consentMethod: 'told_at_start' } }) }),
    ]) {
      const response = await attempt;
      expect(response.status).toBe(401);
      expect(((await response.json()) as { code: string }).code).toBe('EXTENSION_TOKEN_INVALID');
    }
  });

  it('refuses a malformed or unknown token the same way, and a removed member at once', async () => {
    for (const bad of ['crx_', 'crx_short', `crx_${randomBytes(32).toString('base64url')}`, `crx_${'A'.repeat(43)}`]) {
      const response = await app.request('/api/extension/me', { headers: asToken(bad) });
      expect(response.status).toBe(401);
      expect(((await response.json()) as { code: string }).code).toBe('EXTENSION_TOKEN_INVALID');
    }
    await join('leaver', 'member');
    const { token } = await signedIn('leaver');
    expect((await app.request('/api/extension/me', { headers: asToken(token) })).status).toBe(200);
    const email = accounts.get('leaver')?.email;
    await admin((c) => c.query('DELETE FROM crove_kernel.tenant_member WHERE org_id = $1 AND user_id = (SELECT id FROM crove_kernel.user_account WHERE email = $2)', [orgId, email]));
    expect((await app.request('/api/extension/me', { headers: asToken(token) })).status).toBe(401);
  });

  // ---- Token lifecycle (#2740) ----------------------------------------------------------------------------------------
  const live = (tokenId: string) => admin(async (c) => (await c.query('SELECT 1 FROM crove_kernel.extension_token WHERE id = $1 AND revoked_at IS NULL', [tokenId])).rowCount === 1);
  const me = async (token: string) => (await app.request('/api/extension/me', { headers: asToken(token) })).status;
  const userIdOf = (name: string) => admin(async (c) => (await c.query('SELECT id FROM crove_kernel.user_account WHERE email = $1', [accounts.get(name)?.email])).rows[0].id as string);
  const autoRevokeRows = (tokenId: string) =>
    admin(async (c) => (await c.query(`SELECT actor_type, actor_id, outcome, target_type, target_id, detail FROM crove_kernel.audit_event WHERE command = 'kernel.extension.token.auto_revoked' AND target_id = $1`, [tokenId])).rows as Array<{ actor_type: string; actor_id: string | null; outcome: string; target_type: string; target_id: string; detail: Record<string, unknown> }>);

  it('refuses a code for an extension id outside the allow-list, and one without an id', async () => {
    const outside = await connect('recorder', slug, ['meetings'], OTHER_EXT_ID);
    expect(outside.status).toBe(403);
    expect(outside.code).not.toMatch(/^crc_/);
    const missing = await app.request('/api/extension/authorize', { method: 'POST', headers: await asBrowser('recorder'), body: JSON.stringify({ codeChallenge: challengeOf('v'.repeat(43)), codeChallengeMethod: 'S256', scopes: ['meetings'], deviceName: 'x' }) });
    expect(missing.status).toBe(422);
    const malformed = await connect('recorder', slug, ['meetings'], 'A'.repeat(32));
    expect(malformed.status).toBe(422);
    // A deployment lists its own extension ids (EXTENSION_IDS): the store's id is then not one of them.
    const own = loadConfig({ DATABASE_URL: appUrlText, AUTH_JWT_SECRET: SECRET, AUTH_ISSUER: ISSUER, AUTH_SESSION_CHECK: 'off', MIGRATIONS_DIR: MIGRATIONS, WEB_DIST: '/nonexistent', EXTENSION_IDS: `${OTHER_EXT_ID}, ${'c'.repeat(32)}` });
    expect(own.EXTENSION_IDS).toEqual([OTHER_EXT_ID, 'c'.repeat(32)]);
    expect(() => loadConfig({ DATABASE_URL: appUrlText, AUTH_JWT_SECRET: SECRET, AUTH_ISSUER: ISSUER, AUTH_SESSION_CHECK: 'off', MIGRATIONS_DIR: MIGRATIONS, WEB_DIST: '/nonexistent', EXTENSION_IDS: 'not-an-id' })).toThrow(/EXTENSION_IDS/);
    const configured = (await app.request('/api/config')).json() as Promise<{ extensionIds: string[] }>;
    expect((await configured).extensionIds).toEqual([EXT_ID]);
    // No EXTENSION_IDS: the default list holds the Chrome Web Store build's id (#3010) and nothing else.
    const none = loadConfig({ DATABASE_URL: appUrlText, AUTH_JWT_SECRET: SECRET, AUTH_ISSUER: ISSUER, AUTH_SESSION_CHECK: 'off', MIGRATIONS_DIR: MIGRATIONS, WEB_DIST: '/nonexistent' });
    expect(none.EXTENSION_IDS).toBeUndefined();
    expect(DEFAULT_EXTENSION_IDS).toEqual([STORE_EXT_ID]);
    const byDefault = createHttpApp({ config: none, runtime: sharedRuntime, store, broker: sharedBroker, authenticate: createAuthenticator(none, sharedDb), pool, aiEnabled: false });
    expect(((await (await byDefault.request('/api/config')).json()) as { extensionIds: string[] }).extensionIds).toEqual([STORE_EXT_ID]);
    const authorizeAs = async (extensionId: string) =>
      byDefault.request('/api/extension/authorize', {
        method: 'POST',
        headers: await asBrowser('recorder'),
        body: JSON.stringify({ extensionId, codeChallenge: challengeOf('v'.repeat(43)), codeChallengeMethod: 'S256', scopes: ['meetings'], deviceName: 'x' }),
      });
    // The store build's id receives a code with EXTENSION_IDS unset; any id not listed is still refused.
    const accepted = await authorizeAs(STORE_EXT_ID);
    expect(accepted.status).toBe(200);
    expect(((await accepted.json()) as { code?: string }).code).toMatch(/^crc_/);
    const refusedAll = await authorizeAs(EXT_ID);
    expect(refusedAll.status).toBe(403);
    // A server that sets EXTENSION_IDS uses only that list: the store id is refused unless it is named there.
    expect((await app.request('/api/extension/authorize', { method: 'POST', headers: await asBrowser('recorder'), body: JSON.stringify({ extensionId: STORE_EXT_ID, codeChallenge: challengeOf('v'.repeat(43)), codeChallengeMethod: 'S256', scopes: ['meetings'], deviceName: 'x' }) })).status).toBe(403);
  });

  it('voids a member\'s tokens for good when their role drops below member, with one audit row of ids only', async () => {
    await join('demoted', 'member');
    const { token, tokenId } = await signedIn('demoted');
    const userId = await userIdOf('demoted');
    expect(await me(token)).toBe(200);
    await admin((c) => c.query(`UPDATE crove_kernel.tenant_member SET role = 'viewer' WHERE org_id = $1 AND user_id = $2`, [orgId, userId]));
    expect(await me(token)).toBe(401);
    expect(await live(tokenId)).toBe(false);
    // Restoring the role does not bring the device back.
    await admin((c) => c.query(`UPDATE crove_kernel.tenant_member SET role = 'member' WHERE org_id = $1 AND user_id = $2`, [orgId, userId]));
    expect(await me(token)).toBe(401);
    const rows = await autoRevokeRows(tokenId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_type: 'system', actor_id: null, outcome: 'ok', target_type: 'extension_token', target_id: tokenId });
    expect(rows[0]!.detail).toEqual({ tokenId, userId, reason: 'role_change' });
    // A change between roles that all hold the feature voids nothing.
    const second = await signedIn('demoted');
    await admin((c) => c.query(`UPDATE crove_kernel.tenant_member SET role = 'admin' WHERE org_id = $1 AND user_id = $2`, [orgId, userId]));
    expect(await me(second.token)).toBe(200);
    expect(await autoRevokeRows(second.tokenId)).toHaveLength(0);
    expect(await live(second.tokenId)).toBe(true);
    await admin((c) => c.query(`UPDATE crove_kernel.tenant_member SET role = 'member' WHERE org_id = $1 AND user_id = $2`, [orgId, userId]));
  });

  it('voids the tokens of a member whose role is changed through the runtime command, and of one who is removed', async () => {
    await join('changed', 'member');
    const first = await signedIn('changed');
    const second = await signedIn('changed');
    const userId = await userIdOf('changed');
    const changed = await rpc('org/changeMemberRole', await asBrowser('owner', slug, true), { userId, role: 'viewer', idempotencyKey: randomUUID() });
    expect(changed.status).toBe(200);
    for (const device of [first, second]) {
      expect(await me(device.token)).toBe(401);
      expect(await live(device.tokenId)).toBe(false);
      const rows = await autoRevokeRows(device.tokenId);
      expect(rows).toHaveLength(1);
      // The member's own session in this org is stamped as the actor; the detail names ids and the reason only.
      expect(rows[0]!.detail).toEqual({ tokenId: device.tokenId, userId, reason: 'role_change' });
      expect(rows[0]!.outcome).toBe('ok');
    }
    // Removing a member voids a live token and says so; a token made after the role came back is a new one.
    const restored = await rpc('org/changeMemberRole', await asBrowser('owner', slug, true), { userId, role: 'member', idempotencyKey: randomUUID() });
    expect(restored.status).toBe(200);
    expect(await me(first.token)).toBe(401);
    const third = await signedIn('changed');
    expect(await me(third.token)).toBe(200);
    await admin((c) => c.query('DELETE FROM crove_kernel.tenant_member WHERE org_id = $1 AND user_id = $2', [orgId, userId]));
    expect(await live(third.tokenId)).toBe(false);
    const removed = await autoRevokeRows(third.tokenId);
    expect(removed).toHaveLength(1);
    expect(removed[0]!.detail).toEqual({ tokenId: third.tokenId, userId, reason: 'member_removed' });
  });

  it('keeps an exchange that races a demotion or a disable from leaving a live token', async () => {
    // The demotion (or disable) is in flight and holds its row when the exchange starts; the exchange must wait for it
    // and then see it, not read the old role and make a token the demotion's trigger can no longer see.
    for (const kind of ['demotion', 'disable'] as const) {
      const name = `racer_${kind}`;
      await join(name, 'member');
      const userId = await userIdOf(name);
      const first = await connect(name);
      expect(first.status).toBe(200);
      const holder = new pg.Client({ connectionString: adminUrl });
      await holder.connect();
      try {
        await holder.query('BEGIN');
        if (kind === 'demotion') await holder.query(`UPDATE crove_kernel.tenant_member SET role = 'viewer' WHERE org_id = $1 AND user_id = $2`, [orgId, userId]);
        else await holder.query('UPDATE crove_kernel.user_account SET disabled_at = now() WHERE id = $1', [userId]);
        const exchanging = exchange(first.code, first.verifier);
        // Give the exchange time to reach its lock wait; it must not have finished while the change is uncommitted.
        const early = await Promise.race([exchanging.then(() => 'finished'), new Promise((r) => setTimeout(() => r('waiting'), 600))]);
        expect(early, 'the exchange waits for the change in flight').toBe('waiting');
        await holder.query('COMMIT');
        const done = await exchanging;
        expect(done.status).toBe(400);
      } finally {
        await holder.end().catch(() => undefined);
      }
      const live = await admin(async (c) => (await c.query('SELECT count(*)::int AS n FROM crove_kernel.extension_token WHERE user_id = $1 AND revoked_at IS NULL', [userId])).rows[0].n as number);
      expect(live, `no live token after a ${kind} that raced the exchange`).toBe(0);
      if (kind === 'disable') await admin((c) => c.query('UPDATE crove_kernel.user_account SET disabled_at = NULL WHERE id = $1', [userId]));
    }
  });

  it('voids a user\'s tokens for good when the account is disabled, also through the operator\'s no-context path', async () => {
    await join('disabled', 'member');
    const { token, tokenId } = await signedIn('disabled');
    const userId = await userIdOf('disabled');
    // The user-disable role: the worker login, no org context. Its session is not staff, so the audit row is written under
    // the plain rules of the table.
    const workerUrl = new URL(adminUrl);
    workerUrl.username = 'crove_worker';
    workerUrl.password = 'test-worker-pw';
    const worker = new pg.Client({ connectionString: workerUrl.toString() });
    await worker.connect();
    try {
      await worker.query(`SELECT * FROM crove_kernel.user_set_disabled($1, true, 'test')`, [accounts.get('disabled')?.email]);
    } finally {
      await worker.end();
    }
    expect(await me(token)).toBe(401);
    await admin((c) => c.query(`UPDATE crove_kernel.user_account SET disabled_at = NULL WHERE id = $1`, [userId]));
    expect(await me(token)).toBe(401);
    expect(await live(tokenId)).toBe(false);
    const rows = await autoRevokeRows(tokenId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor_type).toBe('system');
    expect(rows[0]!.detail).toEqual({ tokenId, userId, reason: 'user_disabled' });
    // A token made after the account is back works.
    const again = await signedIn('disabled');
    expect(await me(again.token)).toBe(200);
  });

  it('lets an owner or admin revoke a member\'s device, and no member revoke another member\'s', async () => {
    await join('boss', 'admin');
    await join('peer', 'member');
    const device = await signedIn('recorder');
    const peerDevice = await signedIn('peer');
    const ownerDevice = await signedIn('owner');
    // A member (and a viewer) can neither list the org's devices nor revoke another member's.
    for (const name of ['recorder', 'viewer']) {
      expect((await rpc('extension/tokens/listOrg', await asBrowser(name), {})).status).toBe(403);
      expect((await rpc('extension/tokens/revokeMember', await asBrowser(name), { tokenId: peerDevice.tokenId })).status).toBe(403);
    }
    expect((await rpc('extension/tokens/revoke', await asBrowser('recorder'), { tokenId: peerDevice.tokenId })).status).toBe(404);
    expect(await me(peerDevice.token)).toBe(200);
    // An admin lists every member's devices, never a hash, and revokes one; the audit row names the token and its member.
    const listed = await rpc('extension/tokens/listOrg', await asBrowser('boss'), {});
    expect(listed.status).toBe(200);
    expect(JSON.stringify(listed.body)).not.toMatch(/hash/i);
    const ids = (Object.values(listed.body).flat() as Array<{ id: string }>).map((t) => t.id);
    expect(ids).toEqual(expect.arrayContaining([device.tokenId, peerDevice.tokenId, ownerDevice.tokenId]));
    const revoked = await rpc('extension/tokens/revokeMember', await asBrowser('boss'), { tokenId: device.tokenId });
    expect(revoked.status).toBe(200);
    expect(revoked.body).toMatchObject({ tokenId: device.tokenId, userId: await userIdOf('recorder'), revoked: true });
    expect(await me(device.token)).toBe(401);
    const audit = await admin(async (c) => (await c.query(`SELECT detail FROM crove_kernel.audit_event WHERE command = 'kernel.extension.token.revoke_member' AND outcome = 'ok' AND detail->>'tokenId' = $1`, [device.tokenId])).rows as Array<{ detail: Record<string, unknown> }>);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.detail).toMatchObject({ tokenId: device.tokenId, userId: await userIdOf('recorder') });
    expect(JSON.stringify(audit[0]!.detail)).not.toMatch(/crx_|hash|Chrome/i);
    // Again, unknown ids and another org's ids read alike; an admin may not cut off an owner's device, the owner may.
    expect((await rpc('extension/tokens/revokeMember', await asBrowser('boss'), { tokenId: device.tokenId })).status).toBe(404);
    expect((await rpc('extension/tokens/revokeMember', await asBrowser('boss'), { tokenId: randomUUID() })).status).toBe(404);
    expect((await rpc('extension/tokens/revokeMember', await asBrowser('boss'), { tokenId: ownerDevice.tokenId })).status).toBe(404);
    expect(await me(ownerDevice.token)).toBe(200);
    expect((await rpc('extension/tokens/revokeMember', await asBrowser('owner'), { tokenId: peerDevice.tokenId })).status).toBe(200);
    expect(await me(peerDevice.token)).toBe(401);
    // The extension's own token reaches none of this.
    expect((await rpc('extension/tokens/revokeMember', asToken(ownerDevice.token), { tokenId: ownerDevice.tokenId })).status).toBe(403);
  });

  it('leaves no usable token row when the exchange\'s audit write fails', async () => {
    const failing = new Runtime(sharedDb, { manifests: TEST_MANIFESTS, sessions: createSessionStatusSource('off'), stepUp: 'required' }).register({
      commands: [...kernelCommands, ...financeCommands, ...meetingsCommands].filter((c) => c.name !== 'kernel.extension.token.exchanged'),
      queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries, ...meetingsQueries],
    });
    const broken = createHttpApp({
      config: sharedConfig,
      runtime: failing,
      store,
      broker: sharedBroker,
      authenticate: createAuthenticator(sharedConfig, sharedDb),
      pool,
      aiEnabled: false,
      extensionTokenLimit: new RateLimiter({ perMinute: 40 }),
    });
    await join('unlucky', 'member');
    const userId = await userIdOf('unlucky');
    const verifier = randomBytes(32).toString('base64url');
    const authorize = await app.request('/api/extension/authorize', {
      method: 'POST',
      headers: await asBrowser('unlucky'),
      body: JSON.stringify({ extensionId: EXT_ID, codeChallenge: challengeOf(verifier), codeChallengeMethod: 'S256', scopes: ['meetings'], deviceName: 'Chrome' }),
    });
    const { code } = (await authorize.json()) as { code: string };
    const response = await broken.request('/api/extension/token', { method: 'POST', headers: { 'content-type': 'application/json', origin: originOf(EXT_ID) }, body: JSON.stringify({ code, codeVerifier: verifier }) });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(await response.json())).not.toMatch(/crx_/);
    const rows = await admin(async (c) => (await c.query('SELECT id, revoked_at FROM crove_kernel.extension_token WHERE user_id = $1', [userId])).rows as Array<{ id: string; revoked_at: Date | null }>);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.revoked_at).not.toBeNull();
    const audit = await autoRevokeRows(rows[0]!.id);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.detail).toEqual({ tokenId: rows[0]!.id, userId, reason: 'exchange_failed' });
  });

  it('limits the code exchange per client and caps its body', async () => {
    const limited = createHttpApp({
      config: loadConfig({ DATABASE_URL: 'postgres://localhost/x', AUTH_JWT_SECRET: SECRET, AUTH_ISSUER: ISSUER, AUTH_SESSION_CHECK: 'off', MIGRATIONS_DIR: MIGRATIONS, WEB_DIST: '/nonexistent' }),
      runtime: { installed: () => true, modules: () => [], orgless: async () => null } as unknown as Runtime,
      store,
      authenticate: async () => {
        throw new Error('unused');
      },
      pool,
      aiEnabled: false,
      extensionTokenLimit: new RateLimiter({ perMinute: 3 }),
    });
    const post = (body: string) => limited.request('/api/extension/token', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    const statuses: number[] = [];
    for (let i = 0; i < 5; i += 1) statuses.push((await post('{}')).status);
    expect(statuses).toEqual([400, 400, 400, 429, 429]);
    // An oversize body is turned away before the budget is asked.
    expect((await post('x'.repeat(2000))).status).toBe(413);
    // Tokens are counted per client before any is looked up, so random ones cannot each cost a database call.
    const flood = createHttpApp({
      config: loadConfig({ DATABASE_URL: 'postgres://localhost/x', AUTH_JWT_SECRET: SECRET, AUTH_ISSUER: ISSUER, AUTH_SESSION_CHECK: 'off', MIGRATIONS_DIR: MIGRATIONS, WEB_DIST: '/nonexistent' }),
      runtime: { installed: () => true, modules: () => [] } as unknown as Runtime,
      store,
      authenticate: async () => {
        throw new DomainError('EXTENSION_TOKEN_INVALID', 401, 'no');
      },
      pool,
      aiEnabled: false,
      extensionBearerLimit: new RateLimiter({ perMinute: 2 }),
    });
    const probe = () => flood.request('/api/extension/me', { headers: { authorization: `Bearer crx_${'A'.repeat(43)}` } });
    expect([(await probe()).status, (await probe()).status, (await probe()).status]).toEqual([401, 401, 429]);
    const open = createHttpApp({
      config: loadConfig({ DATABASE_URL: 'postgres://localhost/x', AUTH_JWT_SECRET: SECRET, AUTH_ISSUER: ISSUER, AUTH_SESSION_CHECK: 'off', MIGRATIONS_DIR: MIGRATIONS, WEB_DIST: '/nonexistent' }),
      runtime: { installed: () => true, modules: () => [] } as unknown as Runtime,
      store,
      authenticate: async () => {
        throw new Error('unused');
      },
      pool,
      aiEnabled: false,
    });
    expect((await open.request('/api/extension/token', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pad: 'x'.repeat(2000) }) })).status).toBe(413);
  });
});

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
import { kernelCommands, kernelQueries } from '@crove/kernel';
import { BlobNotFoundError, DomainError, Runtime, sha256Hex, type BlobStore, type CredentialBroker } from '@crove/kernel-runtime';
import { financeCommands, financeQueries } from '@crove/mod-finance';
import { meetingsCommands, meetingsQueries } from '@crove/mod-meetings';
import { createAuthenticator } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
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
  async function connect(name: string, org = slug, scopes: string[] = ['meetings']) {
    const verifier = randomBytes(32).toString('base64url');
    const authorize = await app.request('/api/extension/authorize', {
      method: 'POST',
      headers: await asBrowser(name, org),
      body: JSON.stringify({ codeChallenge: challengeOf(verifier), codeChallengeMethod: 'S256', scopes, deviceName: 'Chrome trên máy bàn' }),
    });
    const issued = (await authorize.json()) as { code?: string };
    return { verifier, status: authorize.status, code: issued.code ?? '' };
  }

  async function exchange(code: string, codeVerifier: string) {
    const response = await app.request('/api/extension/token', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, codeVerifier }) });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  async function signedIn(name: string) {
    const first = await connect(name);
    expect(first.status).toBe(200);
    const done = await exchange(first.code, first.verifier);
    expect(done.status).toBe(200);
    return done.body as { token: string; tokenId: string; orgId: string; scopes: string[]; expiresAt: string };
  }

  async function join(name: string, role: 'member' | 'viewer') {
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
    pool = createPool({ connectionString: appUrl.toString(), max: 8 });
    const db = createDb(pool);
    const config = loadConfig({ DATABASE_URL: appUrl.toString(), AUTH_JWT_SECRET: SECRET, AUTH_ISSUER: ISSUER, AUTH_SESSION_CHECK: 'off', MIGRATIONS_DIR: MIGRATIONS, WEB_DIST: '/nonexistent' });
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

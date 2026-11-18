// SPDX-License-Identifier: AGPL-3.0-only
// Connecting Zoom end to end through the HTTP rpc (meetings integrations C3, #3175, PR B): `meetingPlatform/providers`, `connectStart` and `connectFinish` against a REAL database and a Zoom adapter whose
// transport is a stub (no Zoom host is ever called). The state is single use and the member's own, the PKCE verifier reaches Zoom's token endpoint and matches the challenge of the dialog, the tokens are
// sealed for the member's Zoom account in the shape the sweep and the refresh open, and nothing the platform returned is ever in an answer. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own
// database.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { kernelCommands, kernelQueries } from '@crove/kernel';
import { meetingPlatformBinding } from '@crove/kernel-contract';
import { ZoomMeetingPlatform, type Fetch } from '@crove/channel';
import { CredentialVault, Runtime, parseVaultKey, type BlobStore } from '@crove/kernel-runtime';
import { createAuthenticator } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { noCredentialBroker } from '../src/credentials.ts';
import { createHttpApp } from '../src/http.ts';
import { parseCredential } from '../src/meeting-platform-credential.ts';
import { createSessionStatusSource } from '../src/sessions.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const SECRET = 'test-only-jwt-secret-for-meeting-zoom-0123456789';
const ISSUER = 'crove-auth';
const suite = ADMIN ? describe : describe.skip;
const APP_URL = 'https://app.example.test';
const ZOOM_APP = { clientId: 'zoom-client-id-0001', clientSecret: 'zoom-client-secret-not-real' };

interface Account { subject: string; email: string; session: string; userId: string }
const account = (name: string): Account => ({ subject: randomUUID(), email: `${name}@mp-zoom.test`, session: randomUUID(), userId: '' });

// A Zoom transport that answers from a script and remembers what it was asked.
interface Seen { url: string; body: URLSearchParams | null; authorization: string | undefined }
function zoomStub() {
  const seen: Seen[] = [];
  let tokenStatus = 200;
  let profile: Record<string, unknown> = { id: 'synthetic-user-id-0001', display_name: 'Linh Nguyen', email: 'Linh.Zoom@example.test' };
  const fetchImpl: Fetch = async (url, init) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    seen.push({ url, body: typeof init?.body === 'string' ? new URLSearchParams(init.body) : null, authorization: headers.authorization });
    if (url === 'https://zoom.us/oauth/token') {
      if (tokenStatus !== 200) return new Response(JSON.stringify({ error: 'invalid_grant', reason: 'secret-reason-not-real' }), { status: tokenStatus });
      return new Response(JSON.stringify({ access_token: 'zoom-access-not-real-0001', refresh_token: 'zoom-refresh-not-real-0001', expires_in: 3599, scope: 'cloud_recording:read:list_user_recordings user:read:user' }), { status: 200 });
    }
    if (url === 'https://api.zoom.us/v2/users/me') return new Response(JSON.stringify(profile), { status: 200 });
    return new Response('{}', { status: 404 });
  };
  return { fetchImpl, seen, setTokenStatus: (status: number) => void (tokenStatus = status), setProfile: (next: Record<string, unknown>) => void (profile = next) };
}

suite('Zoom connect through the HTTP rpc (meetings integrations C3, #3175)', () => {
  const dbName = `crove_test_mp_zoom_connect_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  const pools: pg.Pool[] = [];
  let apps: Record<'zoom' | 'noZoom' | 'noKey', ReturnType<typeof createHttpApp>>;
  const vault = new CredentialVault([parseVaultKey(randomBytes(32).toString('base64'))]);
  const stub = zoomStub();
  const owner = account('owner');
  const member = account('member');
  const other = account('other');
  const viewer = account('viewer');
  let org = { slug: '', orgId: '' };

  const sqlAdmin = async <R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params: unknown[] = []) => {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await c.query<R>(text, params);
    } finally {
      await c.end();
    }
  };
  const tokenFor = (who: Account, mfa = false) => {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ role: 'authenticated', email: who.email, session_id: who.session, aal: 'aal1', is_anonymous: false, ...(mfa ? { aal: 'aal2', amr: [{ method: 'totp', timestamp: now }] } : {}) })
      .setProtectedHeader({ alg: 'HS256' }).setSubject(who.subject).setIssuer(ISSUER).setAudience('authenticated').setIssuedAt().setExpirationTime('15m').sign(new TextEncoder().encode(SECRET));
  };
  async function rpc(path: string, who: Account, input: unknown, options: { slug?: string | null; app?: keyof typeof apps; mfa?: boolean } = {}) {
    const slug = options.slug === undefined ? org.slug : options.slug;
    const response = await apps[options.app ?? 'zoom'].request(`/api/rpc/${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await tokenFor(who, options.mfa)}`, 'content-type': 'application/json', ...(slug ? { 'x-crove-org': slug } : {}) },
      body: JSON.stringify(input === undefined ? {} : { json: input }),
    });
    const body = (await response.json().catch(() => null)) as ({ json?: unknown } & Record<string, unknown>) | null;
    return { status: response.status, body: (body && 'json' in body ? body.json : body) as any };
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
    const login = (username: string, password: string) => {
      const url = new URL(adminUrl);
      url.username = username;
      url.password = password;
      return url.toString();
    };
    const appUrl = login('crove_app', 'test-app-pw');
    const pool = createPool({ connectionString: appUrl, max: 4 });
    pools.push(pool);
    const db = createDb(pool);
    const defs = { commands: [...kernelCommands], queries: [...kernelQueries({ inboundDomain: null })] };
    const api = new Runtime(db, { manifests: TEST_MANIFESTS, sessions: createSessionStatusSource('off'), stepUp: 'required' }).register(defs);
    const config = loadConfig({ DATABASE_URL: appUrl, AUTH_JWT_SECRET: SECRET, AUTH_ISSUER: ISSUER, AUTH_SESSION_CHECK: 'off', MIGRATIONS_DIR: MIGRATIONS, WEB_DIST: '/nonexistent' });
    const zoom = { zoom: new ZoomMeetingPlatform(ZOOM_APP, { fetch: stub.fetchImpl }) };
    const make = (channels: Record<string, unknown>) => createHttpApp({ config, runtime: api, store: {} as BlobStore, authenticate: createAuthenticator(config, db), pool, aiEnabled: false, channels: channels as never });
    apps = {
      zoom: make({ broker: vault, publicUrl: APP_URL, meetingPlatforms: zoom }),
      noZoom: make({ broker: vault, publicUrl: APP_URL, meetingPlatforms: {} }),
      noKey: make({ broker: noCredentialBroker, publicUrl: APP_URL, meetingPlatforms: zoom }),
    };

    for (const who of [owner, member, other, viewer]) who.userId = String((await rpc('me/get', who, undefined, { slug: null })).body?.userId);
    const created = await rpc('org/create', owner, { name: 'Công ty Zoom', idempotencyKey: randomUUID() }, { slug: null });
    org = { slug: String(created.body?.slug), orgId: String(created.body?.orgId) };
    for (const [who, role] of [[member, 'member'], [other, 'member'], [viewer, 'viewer']] as const) {
      const invite = await rpc('org/invite', owner, { email: who.email, role }, { mfa: true });
      expect((await rpc('invites/accept', who, { token: String(invite.body?.acceptPath).split('#')[1] }, { slug: null })).status).toBe(200);
    }
  }, 300_000);

  afterAll(async () => {
    await Promise.all(pools.map((p) => p.end()));
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  const start = (who: Account = member, app: keyof typeof apps = 'zoom') => rpc('meetingPlatform/connectStart', who, { provider: 'zoom' }, { app });
  const finish = (who: Account, state: string, code = 'code-not-real-0001', app: keyof typeof apps = 'zoom') => rpc('meetingPlatform/connectFinish', who, { provider: 'zoom', state, code }, { app });
  const connections = async () => (await sqlAdmin<{ id: string; external_account: string; display_name: string; scopes: string[]; status: string; expires_at: Date | null }>(
    "SELECT id, external_account, display_name, scopes, status, expires_at FROM crove_kernel.meeting_platform_connection WHERE org_id = $1 AND provider = 'zoom'", [org.orgId])).rows;

  it('offers Zoom only to a deployment that has the app and a credential key, and to any member', async () => {
    expect((await rpc('meetingPlatform/providers', member, {})).body).toEqual(['zoom']);
    expect((await rpc('meetingPlatform/providers', viewer, {})).body).toEqual(['zoom']);
    expect((await rpc('meetingPlatform/providers', member, {}, { app: 'noZoom' })).body).toEqual([]);
    expect((await rpc('meetingPlatform/providers', member, {}, { app: 'noKey' })).body).toEqual([]);
  });

  it('starts an attempt: an https Zoom address with the app, the return address and a PKCE challenge, a state, and refuses a viewer, a deployment without Zoom and one without a key', async () => {
    const started = await start();
    expect(started.status).toBe(200);
    expect(Object.keys(started.body).sort()).toEqual(['authorizeUrl', 'expiresAt', 'state']);
    const url = new URL(started.body.authorizeUrl as string);
    expect(`${url.origin}${url.pathname}`).toBe('https://zoom.us/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe(ZOOM_APP.clientId);
    expect(url.searchParams.get('redirect_uri')).toBe(`${APP_URL}/meetings/oauth/zoom/callback`);
    expect(url.searchParams.get('state')).toBe(started.body.state);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(String(url.searchParams.get('code_challenge')).length).toBeGreaterThanOrEqual(43);
    expect(String(started.body.authorizeUrl)).not.toContain(ZOOM_APP.clientSecret);
    expect((await start(viewer)).status).toBe(403);
    expect(await start(member, 'noZoom')).toMatchObject({ status: 404, body: { code: 'CHANNEL_PROVIDER_DISABLED' } });
    expect(await start(member, 'noKey')).toMatchObject({ status: 503, body: { code: 'BROKER_NOT_CONFIGURED' } });
    // The database kept the state's hash and the verifier, never the state.
    const rows = await sqlAdmin<{ state_hash: string; provider: string; code_verifier: string | null }>("SELECT state_hash, provider, code_verifier FROM crove_kernel.oauth_state WHERE org_id = $1 AND provider = 'zoom_recordings'", [org.orgId]);
    expect(rows.rows.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(rows.rows)).not.toContain(String(started.body.state));
    expect(rows.rows.every((r) => r.code_verifier !== null)).toBe(true);
  });

  it('finishes the attempt: the verifier matches the challenge, the sealed credential is the one the sweep and the refresh read, and no answer carries a token', async () => {
    stub.seen.length = 0;
    const started = await start();
    const challenge = new URL(started.body.authorizeUrl as string).searchParams.get('code_challenge');
    const done = await finish(member, started.body.state as string);
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ displayName: 'Linh Nguyen', reconnected: false });
    expect(Object.keys(done.body).sort()).toEqual(['connectionId', 'displayName', 'reconnected']);
    const serialized = JSON.stringify(done.body);
    for (const secret of ['zoom-access-not-real-0001', 'zoom-refresh-not-real-0001', ZOOM_APP.clientSecret, 'code-not-real-0001']) expect(serialized).not.toContain(secret);
    // Zoom was asked once for the token (the app's credentials, the code, the return address and the verifier of the SAME attempt) and once for who the member is.
    const token = stub.seen.find((s) => s.url === 'https://zoom.us/oauth/token');
    expect(token?.authorization).toBe(`Basic ${Buffer.from(`${ZOOM_APP.clientId}:${ZOOM_APP.clientSecret}`).toString('base64')}`);
    expect(token?.body?.get('grant_type')).toBe('authorization_code');
    expect(token?.body?.get('code')).toBe('code-not-real-0001');
    expect(token?.body?.get('redirect_uri')).toBe(`${APP_URL}/meetings/oauth/zoom/callback`);
    const verifier = token?.body?.get('code_verifier') ?? '';
    expect(createHash('sha256').update(verifier).digest('base64url')).toBe(challenge);
    expect(stub.seen.find((s) => s.url === 'https://api.zoom.us/v2/users/me')?.authorization).toBe('Bearer zoom-access-not-real-0001');
    // The connection is the member's, named by the Zoom address in lower case, with the scopes and the expiry Zoom gave.
    const rows = await connections();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: done.body.connectionId, external_account: 'linh.zoom@example.test', display_name: 'Linh Nguyen', status: 'active', scopes: ['cloud_recording:read:list_user_recordings', 'user:read:user'] });
    expect(new Date(String(rows[0]?.expires_at)).getTime()).toBeGreaterThan(Date.now() + 3_000_000);
    // The worker's read of the sealed bytes opens under the binding of this org, provider and account, and parses to a credential with an expiry (the refresh and the sweep depend on it).
    const sealed = (await sqlAdmin<{ key_id: string; envelope: Buffer }>('SELECT key_id, envelope FROM crove_kernel.meeting_platform_credential WHERE id = $1', [done.body.connectionId])).rows[0];
    const secret = vault.open({ keyId: String(sealed?.key_id), envelope: sealed?.envelope as Buffer }, meetingPlatformBinding(org.orgId, 'zoom', 'linh.zoom@example.test'));
    const credential = parseCredential(secret);
    expect(credential).toMatchObject({ accessToken: 'zoom-access-not-real-0001', refreshToken: 'zoom-refresh-not-real-0001' });
    expect(credential.expiresAt?.getTime()).toBeGreaterThan(Date.now() + 3_000_000);
    // Nothing of it is in the audit log.
    const audit = await sqlAdmin<{ detail: unknown }>("SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command LIKE 'kernel.meeting_platform.%'", [org.orgId]);
    for (const secretText of ['zoom-access-not-real-0001', 'zoom-refresh-not-real-0001', verifier, String(started.body.state)]) expect(JSON.stringify(audit.rows)).not.toContain(secretText);
  });

  it('a state works once and only for the member who started it; connecting the same account again is a reconnect of the same row', async () => {
    const started = await start();
    const state = started.body.state as string;
    expect(await finish(other, state)).toMatchObject({ status: 400, body: { code: 'OAUTH_STATE_INVALID' } });
    expect(await finish(member, randomBytes(32).toString('base64url'))).toMatchObject({ status: 400, body: { code: 'OAUTH_STATE_INVALID' } });
    const before = await connections();
    const done = await finish(member, state);
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ reconnected: true, connectionId: before[0]?.id });
    expect(await finish(member, state)).toMatchObject({ status: 409, body: { code: 'OAUTH_STATE_USED' } });
    expect(await connections()).toHaveLength(1);
    expect((await finish(viewer, state)).status).toBe(403);
  });

  it('uses the attempt up even when Zoom refuses, says so in a fixed text without Zoom\'s words, and stores nothing', async () => {
    const started = await start(other);
    stub.setTokenStatus(400);
    const refused = await finish(other, started.body.state as string);
    expect(refused).toMatchObject({ status: 400, body: { code: 'OAUTH_CODE_REJECTED' } });
    expect(JSON.stringify(refused.body)).not.toContain('secret-reason-not-real');
    expect(await finish(other, started.body.state as string)).toMatchObject({ status: 409, body: { code: 'OAUTH_STATE_USED' } });
    stub.setTokenStatus(503);
    const busy = await start(other);
    expect(await finish(other, busy.body.state as string)).toMatchObject({ status: 503, body: { code: 'OAUTH_PROVIDER_FAILED' } });
    stub.setTokenStatus(200);
    // A Zoom account that gives no address (the app lacks the profile permission) identifies nothing and is refused.
    stub.setProfile({ id: 'synthetic-user-id-0002', display_name: 'No Address' });
    const noAddress = await start(other);
    expect(await finish(other, noAddress.body.state as string)).toMatchObject({ status: 400, body: { code: 'OAUTH_CODE_REJECTED' } });
    stub.setProfile({ id: 'synthetic-user-id-0001', display_name: 'Linh Nguyen', email: 'Linh.Zoom@example.test' });
    expect((await connections()).every((c) => c.external_account === 'linh.zoom@example.test')).toBe(true);
  });

  it('a second member connecting the same Zoom account gets a row of their own, and a deployment without Zoom finishes nothing', async () => {
    const started = await start(other);
    const done = await finish(other, started.body.state as string);
    expect(done.status).toBe(200);
    expect(done.body.reconnected).toBe(false);
    expect(await connections()).toHaveLength(2);
    const lost = await start(member);
    expect(await finish(member, lost.body.state as string, 'code-not-real-0002', 'noZoom')).toMatchObject({ status: 404, body: { code: 'CHANNEL_PROVIDER_DISABLED' } });
  });
});

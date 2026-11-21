// SPDX-License-Identifier: AGPL-3.0-only
// Connecting Google Meet end to end through the HTTP rpc (meetings integrations C2, #3174, PR C): `meetingPlatform/providers`, `connectStart` and `connectFinish` against a REAL database and a Google Meet adapter
// whose transport is a stub (no Google host is ever called). The state is single use and the member's own, the PKCE verifier reaches Google's token endpoint and matches the challenge of the dialog, the tokens are
// sealed for the member's Google account in the shape the sweep and the refresh open, a grant without the Meet transcript permission is refused, and nothing the platform returned is ever in an answer. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own
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
import { GoogleMeetAdapter, type Fetch } from '@crove/channel';
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
const SECRET = 'test-only-jwt-secret-for-meeting-google-0123456789';
const ISSUER = 'crove-auth';
const suite = ADMIN ? describe : describe.skip;
const APP_URL = 'https://app.example.test';
const GOOGLE_APP = { clientId: '123456789012-abcdefgh12345678.apps.googleusercontent.com', clientSecret: 'google-client-secret-not-real' };
const MEET_SCOPE = 'https://www.googleapis.com/auth/meetings.space.readonly';

interface Account { subject: string; email: string; session: string; userId: string }
const account = (name: string): Account => ({ subject: randomUUID(), email: `${name}@mp-google.test`, session: randomUUID(), userId: '' });

// A Google transport that answers from a script and remembers what it was asked.
interface Seen { url: string; body: URLSearchParams | null; authorization: string | undefined }
function googleStub() {
  const seen: Seen[] = [];
  let tokenStatus = 200;
  let scope = `openid https://www.googleapis.com/auth/userinfo.email ${MEET_SCOPE}`;
  let profile: Record<string, unknown> = { sub: '110248495921238986420', email: 'Linh.Google@Example.Test', email_verified: true };
  const fetchImpl: Fetch = async (url, init) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    seen.push({ url, body: typeof init?.body === 'string' ? new URLSearchParams(init.body) : null, authorization: headers.authorization });
    if (url === 'https://oauth2.googleapis.com/token') {
      if (tokenStatus !== 200) return new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'secret-reason-not-real' }), { status: tokenStatus });
      return new Response(JSON.stringify({ access_token: 'google-access-not-real-0001', refresh_token: 'google-refresh-not-real-0001', expires_in: 3599, scope, token_type: 'Bearer' }), { status: 200 });
    }
    if (url === 'https://www.googleapis.com/oauth2/v3/userinfo') return new Response(JSON.stringify(profile), { status: 200 });
    return new Response('{}', { status: 404 });
  };
  return {
    fetchImpl,
    seen,
    setTokenStatus: (status: number) => void (tokenStatus = status),
    setScope: (next: string) => void (scope = next),
    setProfile: (next: Record<string, unknown>) => void (profile = next),
  };
}

suite('Google Meet connect through the HTTP rpc (meetings integrations C2, #3174)', () => {
  const dbName = `crove_test_mp_google_connect_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  const pools: pg.Pool[] = [];
  let apps: Record<'google' | 'noGoogle' | 'noKey', ReturnType<typeof createHttpApp>>;
  const vault = new CredentialVault([parseVaultKey(randomBytes(32).toString('base64'))]);
  const stub = googleStub();
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
    const response = await apps[options.app ?? 'google'].request(`/api/rpc/${path}`, {
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
    const google = { google_meet: new GoogleMeetAdapter({ app: GOOGLE_APP, refresher: { refresh: async () => ({ refused: 'not used here' }) }, fetch: stub.fetchImpl }) };
    const make = (channels: Record<string, unknown>) => createHttpApp({ config, runtime: api, store: {} as BlobStore, authenticate: createAuthenticator(config, db), pool, aiEnabled: false, channels: channels as never });
    apps = {
      google: make({ broker: vault, publicUrl: APP_URL, meetingPlatforms: google }),
      noGoogle: make({ broker: vault, publicUrl: APP_URL, meetingPlatforms: {} }),
      noKey: make({ broker: noCredentialBroker, publicUrl: APP_URL, meetingPlatforms: google }),
    };

    for (const who of [owner, member, other, viewer]) who.userId = String((await rpc('me/get', who, undefined, { slug: null })).body?.userId);
    const created = await rpc('org/create', owner, { name: 'Công ty Google Meet', idempotencyKey: randomUUID() }, { slug: null });
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

  const start = (who: Account = member, app: keyof typeof apps = 'google') => rpc('meetingPlatform/connectStart', who, { provider: 'google_meet' }, { app });
  const finish = (who: Account, state: string, code = 'code-not-real-0001', app: keyof typeof apps = 'google') => rpc('meetingPlatform/connectFinish', who, { provider: 'google_meet', state, code }, { app });
  const connections = async () => (await sqlAdmin<{ id: string; external_account: string; display_name: string; scopes: string[]; status: string; expires_at: Date | null }>(
    "SELECT id, external_account, display_name, scopes, status, expires_at FROM crove_kernel.meeting_platform_connection WHERE org_id = $1 AND provider = 'google_meet'", [org.orgId])).rows;

  it('offers Google Meet only to a deployment that has the client and a credential key, and to any member', async () => {
    expect((await rpc('meetingPlatform/providers', member, {})).body).toEqual(['google_meet']);
    expect((await rpc('meetingPlatform/providers', viewer, {})).body).toEqual(['google_meet']);
    expect((await rpc('meetingPlatform/providers', member, {}, { app: 'noGoogle' })).body).toEqual([]);
    expect((await rpc('meetingPlatform/providers', member, {}, { app: 'noKey' })).body).toEqual([]);
  });

  it('starts an attempt: an https Google address with the client, the return address, the Meet scope and a PKCE challenge, a state, and refuses a viewer, a deployment without Google Meet and one without a key', async () => {
    const started = await start();
    expect(started.status).toBe(200);
    expect(Object.keys(started.body).sort()).toEqual(['authorizeUrl', 'expiresAt', 'state']);
    const url = new URL(started.body.authorizeUrl as string);
    expect(`${url.origin}${url.pathname}`).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('client_id')).toBe(GOOGLE_APP.clientId);
    expect(url.searchParams.get('redirect_uri')).toBe(`${APP_URL}/meetings/oauth/google_meet/callback`);
    expect(url.searchParams.get('state')).toBe(started.body.state);
    expect(url.searchParams.get('scope')).toBe(`openid email ${MEET_SCOPE}`);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(String(url.searchParams.get('code_challenge')).length).toBeGreaterThanOrEqual(43);
    expect(String(started.body.authorizeUrl)).not.toContain(GOOGLE_APP.clientSecret);
    expect((await start(viewer)).status).toBe(403);
    expect(await start(member, 'noGoogle')).toMatchObject({ status: 404, body: { code: 'CHANNEL_PROVIDER_DISABLED' } });
    expect(await start(member, 'noKey')).toMatchObject({ status: 503, body: { code: 'BROKER_NOT_CONFIGURED' } });
    // The database kept the state's hash and the verifier, never the state.
    const rows = await sqlAdmin<{ state_hash: string; provider: string; code_verifier: string | null }>("SELECT state_hash, provider, code_verifier FROM crove_kernel.oauth_state WHERE org_id = $1 AND provider = 'google_recordings'", [org.orgId]);
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
    expect(done.body).toMatchObject({ displayName: 'linh.google@example.test', reconnected: false });
    expect(Object.keys(done.body).sort()).toEqual(['connectionId', 'displayName', 'reconnected']);
    const serialized = JSON.stringify(done.body);
    for (const secret of ['google-access-not-real-0001', 'google-refresh-not-real-0001', GOOGLE_APP.clientSecret, 'code-not-real-0001']) expect(serialized).not.toContain(secret);
    // Google was asked once for the token (the client's credentials, the code, the return address and the verifier of the SAME attempt) and once for who the member is.
    const token = stub.seen.find((s) => s.url === 'https://oauth2.googleapis.com/token');
    expect(token?.body?.get('client_id')).toBe(GOOGLE_APP.clientId);
    expect(token?.body?.get('client_secret')).toBe(GOOGLE_APP.clientSecret);
    expect(token?.body?.get('grant_type')).toBe('authorization_code');
    expect(token?.body?.get('code')).toBe('code-not-real-0001');
    expect(token?.body?.get('redirect_uri')).toBe(`${APP_URL}/meetings/oauth/google_meet/callback`);
    const verifier = token?.body?.get('code_verifier') ?? '';
    expect(createHash('sha256').update(verifier).digest('base64url')).toBe(challenge);
    expect(stub.seen.find((s) => s.url === 'https://www.googleapis.com/oauth2/v3/userinfo')?.authorization).toBe('Bearer google-access-not-real-0001');
    // The connection is the member's, keyed by Google's subject id, named by the address, with the scopes and the expiry Google gave.
    const rows = await connections();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: done.body.connectionId, external_account: '110248495921238986420', display_name: 'linh.google@example.test', status: 'active' });
    expect(rows[0]?.scopes).toContain(MEET_SCOPE);
    expect(new Date(String(rows[0]?.expires_at)).getTime()).toBeGreaterThan(Date.now() + 3_000_000);
    // The worker's read of the sealed bytes opens under the binding of this org, provider and account, and parses to a credential with an expiry (the refresh and the sweep depend on it).
    const sealed = (await sqlAdmin<{ key_id: string; envelope: Buffer }>('SELECT key_id, envelope FROM crove_kernel.meeting_platform_credential WHERE id = $1', [done.body.connectionId])).rows[0];
    const secret = vault.open({ keyId: String(sealed?.key_id), envelope: sealed?.envelope as Buffer }, meetingPlatformBinding(org.orgId, 'google_meet', '110248495921238986420'));
    const credential = parseCredential(secret);
    expect(credential).toMatchObject({ accessToken: 'google-access-not-real-0001', refreshToken: 'google-refresh-not-real-0001' });
    expect(credential.expiresAt?.getTime()).toBeGreaterThan(Date.now() + 3_000_000);
    // Nothing of it is in the audit log.
    const audit = await sqlAdmin<{ detail: unknown }>("SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command LIKE 'kernel.meeting_platform.%'", [org.orgId]);
    for (const secretText of ['google-access-not-real-0001', 'google-refresh-not-real-0001', verifier, String(started.body.state)]) expect(JSON.stringify(audit.rows)).not.toContain(secretText);
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

  it('uses the attempt up even when Google refuses, says so in a fixed text without Google\'s words, and stores nothing; a grant without the Meet permission or an account with no verified address is refused too', async () => {
    const connectionsBefore = (await connections()).length;
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
    // The member unticked the Meet transcript permission on Google's screen: refused now, nothing stored.
    stub.setScope('openid https://www.googleapis.com/auth/userinfo.email');
    const unticked = await start(other);
    expect(await finish(other, unticked.body.state as string)).toMatchObject({ status: 400, body: { code: 'OAUTH_CODE_REJECTED' } });
    stub.setScope(`openid https://www.googleapis.com/auth/userinfo.email ${MEET_SCOPE}`);
    // An address Google has not verified identifies nothing and is refused.
    stub.setProfile({ sub: '110248495921238987777', email: 'unverified@example.test', email_verified: false });
    const unverified = await start(other);
    expect(await finish(other, unverified.body.state as string)).toMatchObject({ status: 400, body: { code: 'OAUTH_CODE_REJECTED' } });
    stub.setProfile({ sub: '110248495921238986420', email: 'Linh.Google@Example.Test', email_verified: true });
    // None of the refused attempts stored a connection.
    expect(await connections()).toHaveLength(connectionsBefore);
  });

  it('a second member connecting the same Google account gets a row of their own, a changed address is still the same connection, and a deployment without Google Meet finishes nothing', async () => {
    const started = await start(other);
    const done = await finish(other, started.body.state as string);
    expect(done.status).toBe(200);
    expect(done.body.reconnected).toBe(false);
    expect(await connections()).toHaveLength(2);
    // The member's Google address changed: the subject id is the key, so it is a reconnect of the same row with the new name.
    stub.setProfile({ sub: '110248495921238986420', email: 'linh.new@example.test', email_verified: true });
    const renamed = await start(member);
    const again = await finish(member, renamed.body.state as string);
    expect(again.body).toMatchObject({ reconnected: true, displayName: 'linh.new@example.test' });
    expect(await connections()).toHaveLength(2);
    const lost = await start(member);
    expect(await finish(member, lost.body.state as string, 'code-not-real-0002', 'noGoogle')).toMatchObject({ status: 404, body: { code: 'CHANNEL_PROVIDER_DISABLED' } });
  });
});

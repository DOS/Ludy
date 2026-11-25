// SPDX-License-Identifier: AGPL-3.0-only
// Connecting Microsoft Teams end to end through the HTTP rpc (meetings integrations C4, #3176, step B): `meetingPlatform/providers`, `connectStart` and `connectFinish` against a REAL database and a Teams
// adapter whose transport is a stub (no Microsoft host is ever called). The state is single use and the member's own, the PKCE verifier reaches the token endpoint and matches the challenge of the dialog,
// the tokens are sealed for the member's tenant and user in the shape the sweep and the refresh open, a tenant that needs its administrator is told so plainly and nothing is stored, and nothing the
// platform returned is ever in an answer. Set LUDY_TEST_ADMIN_URL (or CROVE_TEST_ADMIN_URL) to a superuser URL; each run makes its own database.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { kernelCommands, kernelQueries } from '@ludy/kernel';
import { meetingPlatformBinding } from '@ludy/kernel-contract';
import { TeamsMeetingPlatform, type Fetch } from '@ludy/channel';
import { CredentialVault, Runtime, parseVaultKey, type BlobStore } from '@ludy/kernel-runtime';
import { createAuthenticator } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { noCredentialBroker } from '../src/credentials.ts';
import { createHttpApp } from '../src/http.ts';
import { parseCredential } from '../src/meeting-platform-credential.ts';
import { createSessionStatusSource } from '../src/sessions.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const SECRET = 'test-only-jwt-secret-for-meeting-teams-0123456789';
const ISSUER = 'ludy-auth';
const suite = ADMIN ? describe : describe.skip;
const APP_URL = 'https://app.example.test';
const TEAMS_APP = { clientId: '11111111-2222-4333-8444-555555555555', clientSecret: 'teams-client-secret-not-real' };
const TID = 'd6c9ce1e-4f71-8dc3-5b55-6a411ea46324';
const OID = 'b935e675-5e67-48b9-8d45-249d5f88e964';

interface Account { subject: string; email: string; session: string; userId: string }
const account = (name: string): Account => ({ subject: randomUUID(), email: `${name}@mp-teams.test`, session: randomUUID(), userId: '' });

// A Microsoft token endpoint that answers from a script and remembers what it was asked. The id_token carries only the claims the adapter reads (no signature check is needed for a token received directly).
interface Seen { url: string; body: URLSearchParams | null }
// A full grant: the four Graph permissions the listing and the import read with (a grant without one of them is refused at connect, so a stub that gives less would make every connect fail).
const FULL_SCOPE = 'openid profile offline_access Calendars.ReadBasic OnlineMeetings.Read OnlineMeetingRecording.Read.All OnlineMeetingTranscript.Read.All';
const idToken = (claims: Record<string, unknown>) => `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;
function teamsStub() {
  const seen: Seen[] = [];
  let answer: { status: number; body: Record<string, unknown> } = { status: 200, body: {} };
  const ok = () => ({
    status: 200,
    body: { access_token: 'teams-access-not-real-0001', refresh_token: 'teams-refresh-not-real-0001', expires_in: 3599, scope: FULL_SCOPE, id_token: idToken({ oid: OID, tid: TID, name: 'Linh Nguyen' }) },
  });
  answer = ok();
  const fetchImpl: Fetch = async (url, init) => {
    seen.push({ url, body: typeof init?.body === 'string' ? new URLSearchParams(init.body) : null });
    if (url === 'https://login.microsoftonline.com/organizations/oauth2/v2.0/token') return new Response(JSON.stringify(answer.body), { status: answer.status });
    return new Response('{}', { status: 404 });
  };
  return { fetchImpl, seen, reply: (status: number, body: Record<string, unknown>) => void (answer = { status, body }), reset: () => void (answer = ok()) };
}

suite('Microsoft Teams connect through the HTTP rpc (meetings integrations C4, #3176)', () => {
  const dbName = `ludy_test_mp_teams_connect_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  const pools: pg.Pool[] = [];
  let apps: Record<'teams' | 'noTeams' | 'noKey', ReturnType<typeof createHttpApp>>;
  const vault = new CredentialVault([parseVaultKey(randomBytes(32).toString('base64'))]);
  const stub = teamsStub();
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
    const response = await apps[options.app ?? 'teams'].request(`/api/rpc/${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await tokenFor(who, options.mfa)}`, 'content-type': 'application/json', ...(slug ? { 'x-ludy-org': slug } : {}) },
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
    await setRolePasswords(adminUrl, { ludy_app: 'test-app-pw', ludy_worker: 'test-worker-pw' });
    const login = (username: string, password: string) => {
      const url = new URL(adminUrl);
      url.username = username;
      url.password = password;
      return url.toString();
    };
    const appUrl = login('ludy_app', 'test-app-pw');
    const pool = createPool({ connectionString: appUrl, max: 4 });
    pools.push(pool);
    const db = createDb(pool);
    const defs = { commands: [...kernelCommands], queries: [...kernelQueries({ inboundDomain: null })] };
    const api = new Runtime(db, { manifests: TEST_MANIFESTS, sessions: createSessionStatusSource('off'), stepUp: 'required' }).register(defs);
    const config = loadConfig({ DATABASE_URL: appUrl, AUTH_JWT_SECRET: SECRET, AUTH_ISSUER: ISSUER, AUTH_SESSION_CHECK: 'off', MIGRATIONS_DIR: MIGRATIONS, WEB_DIST: '/nonexistent' });
    const teams = { microsoft_teams: new TeamsMeetingPlatform(TEAMS_APP, { fetch: stub.fetchImpl }) };
    const make = (channels: Record<string, unknown>) => createHttpApp({ config, runtime: api, store: {} as BlobStore, authenticate: createAuthenticator(config, db), pool, aiEnabled: false, channels: channels as never });
    apps = {
      teams: make({ broker: vault, publicUrl: APP_URL, meetingPlatforms: teams }),
      noTeams: make({ broker: vault, publicUrl: APP_URL, meetingPlatforms: {} }),
      noKey: make({ broker: noCredentialBroker, publicUrl: APP_URL, meetingPlatforms: teams }),
    };

    for (const who of [owner, member, other, viewer]) who.userId = String((await rpc('me/get', who, undefined, { slug: null })).body?.userId);
    const created = await rpc('org/create', owner, { name: 'Công ty Teams', idempotencyKey: randomUUID() }, { slug: null });
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

  const start = (who: Account = member, app: keyof typeof apps = 'teams') => rpc('meetingPlatform/connectStart', who, { provider: 'microsoft_teams' }, { app });
  const finish = (who: Account, state: string, code = 'code-not-real-0001', app: keyof typeof apps = 'teams') => rpc('meetingPlatform/connectFinish', who, { provider: 'microsoft_teams', state, code }, { app });
  const connections = async () => (await sqlAdmin<{ id: string; external_account: string; display_name: string; scopes: string[]; status: string; expires_at: Date | null }>(
    "SELECT id, external_account, display_name, scopes, status, expires_at FROM ludy_kernel.meeting_platform_connection WHERE org_id = $1 AND provider = 'microsoft_teams'", [org.orgId])).rows;

  it('offers Teams only to a deployment that has the app and a credential key, and to any member', async () => {
    expect((await rpc('meetingPlatform/providers', member, {})).body).toEqual(['microsoft_teams']);
    expect((await rpc('meetingPlatform/providers', viewer, {})).body).toEqual(['microsoft_teams']);
    expect((await rpc('meetingPlatform/providers', member, {}, { app: 'noTeams' })).body).toEqual([]);
    expect((await rpc('meetingPlatform/providers', member, {}, { app: 'noKey' })).body).toEqual([]);
  });

  it('starts an attempt: an https Microsoft address for work and school accounts with the app, the return address, the narrow scopes and a PKCE challenge; refuses a viewer, a deployment without Teams and one without a key', async () => {
    const started = await start();
    expect(started.status).toBe(200);
    expect(Object.keys(started.body).sort()).toEqual(['authorizeUrl', 'expiresAt', 'state']);
    const url = new URL(started.body.authorizeUrl as string);
    expect(`${url.origin}${url.pathname}`).toBe('https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize');
    expect(url.searchParams.get('client_id')).toBe(TEAMS_APP.clientId);
    expect(url.searchParams.get('redirect_uri')).toBe(`${APP_URL}/meetings/oauth/microsoft_teams/callback`);
    expect(url.searchParams.get('state')).toBe(started.body.state);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('scope')).toContain('OnlineMeetingRecording.Read.All');
    expect(url.searchParams.get('scope')).not.toMatch(/User\.Read|ReadWrite|Mail/);
    expect(String(started.body.authorizeUrl)).not.toContain(TEAMS_APP.clientSecret);
    expect((await start(viewer)).status).toBe(403);
    expect(await start(member, 'noTeams')).toMatchObject({ status: 404, body: { code: 'CHANNEL_PROVIDER_DISABLED' } });
    expect(await start(member, 'noKey')).toMatchObject({ status: 503, body: { code: 'BROKER_NOT_CONFIGURED' } });
    // The database kept the state's hash and the verifier under the attempt name of the Teams import, never the state.
    const rows = await sqlAdmin<{ state_hash: string; code_verifier: string | null }>("SELECT state_hash, code_verifier FROM ludy_kernel.oauth_state WHERE org_id = $1 AND provider = 'teams_recordings'", [org.orgId]);
    expect(rows.rows.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(rows.rows)).not.toContain(String(started.body.state));
    expect(rows.rows.every((r) => r.code_verifier !== null)).toBe(true);
  });

  it('finishes the attempt: the verifier matches the challenge, the credential is sealed for the tenant and user and is the one the sweep and the refresh read, and no answer carries a token', async () => {
    stub.seen.length = 0;
    const started = await start();
    const challenge = new URL(started.body.authorizeUrl as string).searchParams.get('code_challenge');
    const done = await finish(member, started.body.state as string);
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ displayName: 'Linh Nguyen', reconnected: false });
    expect(Object.keys(done.body).sort()).toEqual(['connectionId', 'displayName', 'reconnected']);
    const serialized = JSON.stringify(done.body);
    for (const secret of ['teams-access-not-real-0001', 'teams-refresh-not-real-0001', TEAMS_APP.clientSecret, 'code-not-real-0001']) expect(serialized).not.toContain(secret);
    // Microsoft was asked once, for the token: the app's credentials, the code, the return address and the verifier of the SAME attempt. No other call is made.
    expect(stub.seen).toHaveLength(1);
    const token = stub.seen[0];
    expect(token?.body?.get('client_secret')).toBe(TEAMS_APP.clientSecret);
    expect(token?.body?.get('grant_type')).toBe('authorization_code');
    expect(token?.body?.get('code')).toBe('code-not-real-0001');
    expect(token?.body?.get('redirect_uri')).toBe(`${APP_URL}/meetings/oauth/microsoft_teams/callback`);
    const verifier = token?.body?.get('code_verifier') ?? '';
    expect(createHash('sha256').update(verifier).digest('base64url')).toBe(challenge);
    // The connection is the member's, keyed by the tenant and user ids (lower case), with the scopes and the expiry Microsoft gave.
    const rows = await connections();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: done.body.connectionId, external_account: `${TID}:${OID}`, display_name: 'Linh Nguyen', status: 'active' });
    expect(rows[0]?.scopes).toContain('OnlineMeetingRecording.Read.All');
    expect(new Date(String(rows[0]?.expires_at)).getTime()).toBeGreaterThan(Date.now() + 3_000_000);
    // The worker's read of the sealed bytes opens under the binding of this org, provider and account, and parses to a credential with an expiry (the refresh and the sweep depend on it).
    const sealed = (await sqlAdmin<{ key_id: string; envelope: Buffer }>('SELECT key_id, envelope FROM ludy_kernel.meeting_platform_credential WHERE id = $1', [done.body.connectionId])).rows[0];
    const secret = vault.open({ keyId: String(sealed?.key_id), envelope: sealed?.envelope as Buffer }, meetingPlatformBinding(org.orgId, 'microsoft_teams', `${TID}:${OID}`));
    const credential = parseCredential(secret);
    expect(credential).toMatchObject({ accessToken: 'teams-access-not-real-0001', refreshToken: 'teams-refresh-not-real-0001' });
    expect(credential.expiresAt?.getTime()).toBeGreaterThan(Date.now() + 3_000_000);
    // Nothing of it is in the audit log.
    const audit = await sqlAdmin<{ detail: unknown }>("SELECT detail FROM ludy_kernel.audit_event WHERE org_id = $1 AND command LIKE 'kernel.meeting_platform.%'", [org.orgId]);
    for (const secretText of ['teams-access-not-real-0001', 'teams-refresh-not-real-0001', verifier, String(started.body.state)]) expect(JSON.stringify(audit.rows)).not.toContain(secretText);
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

  it('tells a tenant that needs its administrator plainly, uses the attempt up, stores nothing and puts no Microsoft words in the answer', async () => {
    const connectionsBefore = (await connections()).length;
    const started = await start(other);
    stub.reply(400, { error: 'invalid_grant', error_description: 'AADSTS65001: The user or administrator has not consented to use the application. secret-reason-not-real', error_codes: [65001] });
    const refused = await finish(other, started.body.state as string);
    expect(refused).toMatchObject({ status: 422, body: { code: 'OAUTH_MEETINGS_ADMIN_CONSENT_REQUIRED' } });
    expect(JSON.stringify(refused.body)).not.toContain('secret-reason-not-real');
    expect(JSON.stringify(refused.body)).not.toContain('AADSTS');
    // Nothing is retried: the same state is used up, and the token endpoint was asked exactly once for it.
    expect(await finish(other, started.body.state as string)).toMatchObject({ status: 409, body: { code: 'OAUTH_STATE_USED' } });
    expect(await connections()).toHaveLength(connectionsBefore);
    stub.reset();
  });

  it('uses the attempt up when Microsoft refuses the code or sends no refresh token or no account, says so in a fixed text, and stores nothing', async () => {
    const connectionsBefore = (await connections()).length;
    const refuse = async (status: number, body: Record<string, unknown>, expected: Record<string, unknown>) => {
      const started = await start(other);
      stub.reply(status, body);
      const answer = await finish(other, started.body.state as string);
      expect(answer).toMatchObject(expected);
      expect(JSON.stringify(answer.body)).not.toContain('secret-reason-not-real');
      expect(await finish(other, started.body.state as string)).toMatchObject({ status: 409, body: { code: 'OAUTH_STATE_USED' } });
    };
    await refuse(400, { error: 'invalid_grant', error_description: 'AADSTS70000: secret-reason-not-real' }, { status: 400, body: { code: 'OAUTH_CODE_REJECTED' } });
    await refuse(503, {}, { status: 503, body: { code: 'OAUTH_PROVIDER_FAILED' } });
    const ok = { access_token: 'teams-access-not-real-0001', expires_in: 3599, scope: FULL_SCOPE, id_token: idToken({ oid: OID, tid: TID }) };
    await refuse(200, ok, { status: 400, body: { code: 'OAUTH_CODE_REJECTED' } });
    await refuse(200, { ...ok, refresh_token: 'teams-refresh-not-real-0001', id_token: idToken({}) }, { status: 400, body: { code: 'OAUTH_CODE_REJECTED' } });
    // A grant that lacks one of the four Graph permissions (here the transcripts) is refused too, instead of connecting and listing nothing; the same grant with all four connects (the cases above).
    await refuse(200, { ...ok, refresh_token: 'teams-refresh-not-real-0001', scope: FULL_SCOPE.replace(' OnlineMeetingTranscript.Read.All', '') }, { status: 400, body: { code: 'OAUTH_CODE_REJECTED' } });
    stub.reset();
    expect(await connections()).toHaveLength(connectionsBefore);
  });

  it('a second member connecting the same Microsoft account gets a row of their own, and a deployment without Teams finishes nothing', async () => {
    const started = await start(other);
    const done = await finish(other, started.body.state as string);
    expect(done.status).toBe(200);
    expect(done.body.reconnected).toBe(false);
    expect(await connections()).toHaveLength(2);
    const lost = await start(member);
    expect(await finish(member, lost.body.state as string, 'code-not-real-0002', 'noTeams')).toMatchObject({ status: 404, body: { code: 'CHANNEL_PROVIDER_DISABLED' } });
  });
});

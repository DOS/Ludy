// SPDX-License-Identifier: AGPL-3.0-only
// The MCP endpoint end to end, on a real database and a real HTTP server (ADR-0051 decision 2, ADR-0032, issue #2975): a client registers itself,
// the owner consents on the consent page's two calls, the client trades its code with PKCE for tokens and reads over /mcp; a revoke, a lost role, a
// stopped org and a reused refresh token each close access at once. The invariants (default-deny scope, no command, token separation) are in
// test/invariant/mcp-*.test.ts.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { createDb, createPool } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { kernelCommands, kernelQueries } from '@ludy/kernel';
import { crmQueries } from '@ludy/mod-crm';
import { financeQueries } from '@ludy/mod-finance';
import { projectsQueries } from '@ludy/mod-projects';
import { socialCommands, socialQueries } from '@ludy/mod-social';
import { BlobNotFoundError, Runtime, sha256Hex, type BlobStore } from '@ludy/kernel-runtime';
import { createAuthenticator } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { createOauthServer } from '../src/oauth-server.ts';
import { installJsonLogs } from '../src/log.ts';
import { createSessionStatusSource } from '../src/sessions.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const SECRET = 'test-only-mcp-secret-0123456789-abcdefghij';
const ISSUER = 'crove-auth-mcp';
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
const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as AddressInfo;
      s.close(() => resolve(port));
    });
  });

suite('the MCP endpoint and its authorization server (#2975)', () => {
  const dbName = `ludy_test_mcp_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let server: Server;
  let base = '';
  let resource = '';
  let bootEnv: Record<string, string> = {};
  let sharedDb: ReturnType<typeof createDb>;
  let sharedRuntime: Runtime;
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

  async function jwt(name: string) {
    let who = accounts.get(name);
    if (!who) {
      who = { subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@mcp.test`, session: randomUUID() };
      accounts.set(name, who);
    }
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ role: 'authenticated', email: who.email, session_id: who.session, is_anonymous: false, aal: 'aal2', amr: [{ method: 'totp', timestamp: now }] })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(who.subject)
      .setIssuer(ISSUER)
      .setAudience('authenticated')
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(new TextEncoder().encode(SECRET));
  }
  const asBrowser = async (name: string, org: string | null = slug) => ({ authorization: `Bearer ${await jwt(name)}`, 'content-type': 'application/json', ...(org ? { 'x-ludy-org': org } : {}) });

  async function rpc(path: string, headers: Record<string, string>, input: unknown) {
    const response = await fetch(`${base}/api/rpc/${path}`, { method: 'POST', headers, body: JSON.stringify(input === undefined ? {} : { json: input }) });
    const body = (await response.json()) as { json?: Record<string, unknown> };
    return { status: response.status, body: (body.json ?? body) as Record<string, unknown> };
  }

  const cookiesOf = (response: Response) => response.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');

  async function register(name = 'Test MCP client', redirect = 'http://127.0.0.1:39999/callback') {
    const response = await fetch(`${base}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: name, redirect_uris: [redirect], application_type: 'native', token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown>, redirect };
  }

  // The authorization request up to the consent page: the provider's redirect and its interaction cookie.
  async function authorize(clientId: string, redirect: string, verifier: string, scope = 'ludy.read') {
    const url = new URL(`${base}/oauth/authorize`);
    url.search = new URLSearchParams({ client_id: clientId, response_type: 'code', redirect_uri: redirect, scope, resource, code_challenge: challengeOf(verifier), code_challenge_method: 'S256', state: 'st-1' }).toString();
    const response = await fetch(url, { redirect: 'manual' });
    return { status: response.status, location: response.headers.get('location') ?? '', cookie: cookiesOf(response) };
  }

  // The whole consent: authorize, the page's details call, the approve call, the resumed authorization, the code.
  async function consent(owner: string, orgOf: string = orgId, decision: 'approve' | 'deny' = 'approve', kind?: 'company' | 'member', opts: { scope?: string; draft?: boolean; writes?: string[] } = {}) {
    const reg = await register();
    expect(reg.status, JSON.stringify(reg.body)).toBe(201);
    const clientId = String(reg.body.client_id);
    const verifier = randomBytes(32).toString('base64url');
    const started = await authorize(clientId, reg.redirect, verifier, opts.scope);
    expect(started.status).toBe(303);
    const uid = new URL(started.location, base).pathname.split('/').pop() as string;
    const headers = { ...(await asBrowser(owner, null)), cookie: started.cookie };
    const detailsResponse = await fetch(`${base}/oauth/interaction/${uid}/details`, { headers });
    const approved = await fetch(`${base}/oauth/interaction/${uid}/consent`, { method: 'POST', headers, body: JSON.stringify(decision === 'approve' ? { decision, orgId: orgOf, ...(kind ? { kind } : {}), ...(opts.draft !== undefined ? { draft: opts.draft } : {}), ...(opts.writes !== undefined ? { writes: opts.writes } : {}) } : { decision }) });
    const answer = (await approved.json()) as { redirectTo?: string; message?: string; code?: string };
    return { clientId, verifier, redirect: reg.redirect, uid, started, details: { status: detailsResponse.status, body: (await detailsResponse.json()) as Record<string, unknown> }, consentStatus: approved.status, redirectTo: answer.redirectTo ?? '', cookie: started.cookie + '; ' + cookiesOf(approved) };
  }

  async function codeOf(c: Awaited<ReturnType<typeof consent>>) {
    const resumed = await fetch(c.redirectTo, { redirect: 'manual', headers: { cookie: c.cookie } });
    const location = new URL(resumed.headers.get('location') ?? 'http://none/', base);
    return { status: resumed.status, location, code: location.searchParams.get('code') ?? '' };
  }

  async function tokens(c: Awaited<ReturnType<typeof consent>>, code: string) {
    const response = await fetch(`${base}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: c.redirect, code_verifier: c.verifier, client_id: c.clientId, resource }).toString(),
    });
    const text = await response.text();
    return { status: response.status, body: (JSON.parse(text.startsWith('{') ? text : '{"raw":' + JSON.stringify(text) + '}')) as Record<string, unknown> };
  }

  async function connect(owner = 'owner') {
    const c = await consent(owner);
    expect(c.consentStatus).toBe(200);
    const { code } = await codeOf(c);
    const t = await tokens(c, code);
    expect(t.status).toBe(200);
    return { ...c, code, access: String(t.body.access_token), refresh: String(t.body.refresh_token) };
  }

  const modernHeaders = (access: string, method: string, name?: string) => ({
    authorization: `Bearer ${access}`,
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': '2026-07-28',
    'mcp-method': method,
    ...(name ? { 'mcp-name': name } : {}),
  });
  async function mcpModern(access: string, method: string, params: Record<string, unknown> = {}, name?: string) {
    const response = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: modernHeaders(access, method, name),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } } }),
    });
    return { status: response.status, body: (await response.json().catch(() => null)) as Record<string, any> | null, headers: response.headers };
  }

  beforeAll(async () => {
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    const dbBase = new URL(ADMIN as string);
    dbBase.pathname = `/${dbName}`;
    adminUrl = dbBase.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { ludy_app: 'test-app-pw', ludy_worker: 'test-worker-pw' });
    const appUrl = new URL(adminUrl);
    appUrl.username = 'ludy_app';
    appUrl.password = 'test-app-pw';
    pool = createPool({ connectionString: appUrl.toString(), max: 8 });
    const db = createDb(pool);
    const port = await freePort();
    base = `http://localhost:${port}`;
    resource = `${base}/mcp`;
    const pair = await generateKeyPair('ES256', { extractable: true });
    const jwk = { ...(await exportJWK(pair.privateKey)), kid: 'test-key-1', alg: 'ES256', use: 'sig' };
    bootEnv = {
      DATABASE_URL: appUrl.toString(),
      AUTH_JWT_SECRET: SECRET,
      AUTH_ISSUER: ISSUER,
      AUTH_SESSION_CHECK: 'off',
      MIGRATIONS_DIR: MIGRATIONS,
      WEB_DIST: '/nonexistent',
      PUBLIC_URL: base,
      OAUTH_SERVER: 'on',
      OAUTH_JWKS: JSON.stringify({ keys: [jwk] }),
      OAUTH_COOKIE_KEYS: 'test-cookie-key-0123456789-abcdefghij-0123',
      MCP_GRANT_PER_MINUTE: '60',
      OAUTH_REGISTER_PER_MINUTE: '1000',
      OAUTH_REGISTER_GLOBAL_PER_MINUTE: '1000',
      MCP_ALLOWED_ORIGINS: 'https://allowed.example.com',
    };
    const config = loadConfig(bootEnv);
    const runtime = new Runtime(db, { manifests: TEST_MANIFESTS, sessions: createSessionStatusSource('off'), stepUp: 'required' }).register({
      commands: [...kernelCommands, ...socialCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries, ...crmQueries, ...projectsQueries, ...socialQueries],
    });
    sharedDb = db;
    sharedRuntime = runtime;
    const oauth = await createOauthServer(config, (fn) => runtime.orgless(fn));
    const app = createHttpApp({ config, oauth, runtime, store: new MemoryStore(), authenticate: createAuthenticator(config, db), pool, aiEnabled: false });
    server = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }) as unknown as Server;
    await new Promise((resolve) => setTimeout(resolve, 100));
    const created = await rpc('org/create', await asBrowser('owner', null), { name: `Mcp Org ${randomUUID().slice(0, 6)}`, idempotencyKey: randomUUID() });
    expect(created.status).toBe(200);
    slug = String(created.body.slug);
    orgId = String(created.body.orgId);
  }, 120_000);

  afterAll(async () => {
    server?.close();
    await pool?.end();
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('publishes its metadata: the resource, the issuer, S256 only, registration, revocation', async () => {
    const protectedResource = (await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json()) as Record<string, unknown>;
    expect(protectedResource).toMatchObject({ resource, authorization_servers: [base], scopes_supported: ['ludy.read', 'ludy.social.draft', 'ludy.engage.write', 'ludy.ads.draft'] });
    for (const path of ['/.well-known/oauth-authorization-server', '/.well-known/openid-configuration']) {
      const meta = (await (await fetch(`${base}${path}`)).json()) as Record<string, any>;
      expect(meta.issuer).toBe(base);
      expect(meta.code_challenge_methods_supported).toEqual(['S256']);
      expect(meta.registration_endpoint).toBe(`${base}/oauth/register`);
      expect(meta.revocation_endpoint).toBe(`${base}/oauth/revoke`);
      expect(meta.token_endpoint_auth_methods_supported).toEqual(['none']);
    }
  });

  it('answers 401 with the resource metadata challenge to a request without a token, and 405 to GET', async () => {
    const response = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain(`resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`);
    expect(response.headers.get('www-authenticate')).toContain('scope="ludy.read"');
    expect((await fetch(`${base}/mcp`)).status).toBe(405);
  });

  it('runs the whole flow: register, consent, code with PKCE, token, and a read over /mcp', async () => {
    const c = await connect();
    expect(c.details.status).toBe(200);
    expect(c.details.body).toMatchObject({ client: { name: 'Test MCP client', redirectHost: '127.0.0.1:39999', selfDeclared: true }, scopes: ['ludy.read'] });
    expect(c.access.split('.')).toHaveLength(3);
    // Whatever scope a client asks for, the token's is the one the grant has.
    expect(JSON.parse(Buffer.from(c.access.split('.')[1] as string, 'base64url').toString())).toMatchObject({ scope: 'ludy.read', aud: resource, client_id: c.clientId, iss: base });
    const about = await mcpModern(c.access, 'tools/call', { name: 'ludy_about', arguments: {} }, 'ludy_about');
    expect(about.status).toBe(200);
    expect(about.body?.result?.structuredContent).toMatchObject({ clientName: 'Test MCP client', scopes: ['ludy.read'] });
    expect(about.body?.result?.resultType).toBe('complete');
    // The audit row says it came over MCP, from which grant and client.
    const rows = await admin((client) => client.query(`SELECT detail FROM ludy_kernel.audit_event WHERE command = 'kernel.mcp.call' ORDER BY id DESC LIMIT 1`));
    expect(rows.rows[0].detail).toMatchObject({ mcpCall: true, tool: 'ludy_about', result: 'ok', mcpClientName: 'Test MCP client' });
  });

  const refreshWith = async (clientId: string, refresh: string) => {
    const response = await fetch(`${base}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh, client_id: clientId, resource }).toString(),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  const grantsOf = async (name = 'owner') => (await rpc('mcp/grant/list', await asBrowser(name), {})).body as unknown as Array<{ id: string; clientName: string; revokedAt: string | null }>;
  const aboutStatus = async (access: string) => (await mcpModern(access, 'tools/call', { name: 'ludy_about', arguments: {} }, 'ludy_about')).status;

  it('answers a request with a Supabase browser token, a garbage token and a token of another audience with 401, and refuses an MCP token on /api', async () => {
    const browser = await jwt('owner');
    expect(await aboutStatus(browser)).toBe(401);
    expect(await aboutStatus('not-a-token')).toBe(401);
    const c = await connect();
    // The MCP access token is not a browser session: /api/rpc refuses it.
    const onApi = await fetch(`${base}/api/rpc/me/get`, { method: 'POST', headers: { authorization: `Bearer ${c.access}`, 'content-type': 'application/json' }, body: '{}' });
    expect(onApi.status).toBe(401);
  });

  it('stores no authorization code, refresh token or access token in clear', async () => {
    const c = await connect();
    const dump = await admin(async (client) => (await client.query<{ blob: string }>(`SELECT pg_catalog.string_agg(payload::text || encode(key_hash, 'hex') || coalesce(grant_id, '') || coalesce(uid, ''), ' ') AS blob FROM ludy_kernel.oauth_record`)).rows[0]?.blob ?? '');
    for (const secret of [c.refresh, c.access, c.code]) expect(dump).not.toContain(secret);
    const hashed = await admin(async (client) => (await client.query(`SELECT 1 FROM ludy_kernel.oauth_record WHERE model = 'RefreshToken' AND key_hash = $1`, [createHash('sha256').update(c.refresh).digest()])).rowCount);
    expect(hashed).toBe(1);
  });

  it('rotates the refresh token and, on a reused one, ends the grant at once', async () => {
    const c = await connect();
    const next = await refreshWith(c.clientId, c.refresh);
    expect(next.status).toBe(200);
    expect(String(next.body.refresh_token)).not.toBe(c.refresh);
    expect(await aboutStatus(String(next.body.access_token))).toBe(200);
    const replay = await refreshWith(c.clientId, c.refresh);
    expect(replay.status).toBe(400);
    // The replay revoked the whole grant: the token issued from the rotation and its refresh token stop too.
    expect(await aboutStatus(String(next.body.access_token))).toBe(401);
    expect((await refreshWith(c.clientId, String(next.body.refresh_token))).status).toBe(400);
  });

  it('closes access at once when the owner revokes the grant, and a refresh after it fails', async () => {
    const c = await connect();
    expect(await aboutStatus(c.access)).toBe(200);
    const mine = (await grantsOf()).filter((g) => g.clientName === 'Test MCP client' && !g.revokedAt);
    expect(mine.length).toBeGreaterThan(0);
    for (const g of mine) expect((await rpc('mcp/grant/revoke', await asBrowser('owner'), { grantId: g.id })).status).toBe(200);
    expect(await aboutStatus(c.access)).toBe(401);
    expect((await refreshWith(c.clientId, c.refresh)).status).toBe(400);
  });

  it('closes access at once when the consenting user loses the owner or admin role', async () => {
    // A second owner consents; the role is lowered in the database; the next call is refused.
    const second = 'second-owner';
    await jwt(second);
    const email = accounts.get(second)?.email;
    const invited = await rpc('org/invite', await asBrowser('owner'), { email, role: 'admin' });
    expect(invited.status).toBe(200);
    const accepted = await rpc('invites/accept', await asBrowser(second, null), { token: String(invited.body.acceptPath).split('#')[1] });
    expect(accepted.status).toBe(200);
    const c = await connect(second);
    expect(await aboutStatus(c.access)).toBe(200);
    await admin((client) => client.query(`UPDATE ludy_kernel.tenant_member SET role = 'member' WHERE org_id = $1 AND user_id = (SELECT id FROM ludy_kernel.user_account WHERE email = $2)`, [orgId, email]));
    expect(await aboutStatus(c.access)).toBe(401);
    expect((await refreshWith(c.clientId, c.refresh)).status).toBe(400);
  });

  // AUTH_ALLOWED_EMAILS binds the grant that outlives a browser session (#3223): the email of the person who gave it against the list on every call, before
  // mcp_grant_verify stamps last_used_at and before any call audit row, so a refused account costs no write.
  it('refuses a grant whose account the allow-list leaves out, on every call and with no database write, and lets it through once it is listed (#3223)', async () => {
    const c = await connect();
    const email = String(accounts.get('owner')?.email);
    const grant = () => admin(async (client) => (await client.query<{ id: string; last_used_at: Date | null }>('SELECT id, last_used_at FROM ludy_kernel.agent_grant WHERE client_id = $1', [c.clientId])).rows[0]);
    const audits = () => admin(async (client) => Number((await client.query<{ n: string }>('SELECT count(*) AS n FROM ludy_kernel.audit_event WHERE org_id = $1', [orgId])).rows[0]?.n));
    const row = await grant();
    expect(row).toBeDefined();
    // Start from a grant that was never used, so a stamp would show.
    await admin((client) => client.query('UPDATE ludy_kernel.agent_grant SET last_used_at = NULL WHERE id = $1', [row?.id]));
    const before = await audits();

    // The same keys and resource, a deployment that lists people: the token verifies there as it does here.
    const appWith = async (list: string) => {
      const config = loadConfig({ ...bootEnv, AUTH_ALLOWED_EMAILS: list });
      const oauth = await createOauthServer(config, (fn) => sharedRuntime.orgless(fn));
      return createHttpApp({ config, oauth, runtime: sharedRuntime, store: new MemoryStore(), authenticate: createAuthenticator(config, sharedDb), pool, aiEnabled: false });
    };
    const call = (target: Awaited<ReturnType<typeof appWith>>, access: string) =>
      target.request(`${base}/mcp`, {
        method: 'POST',
        headers: modernHeaders(access, 'tools/call', 'ludy_about'),
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ludy_about', arguments: {}, _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } } }),
      });

    // The list names somebody else (an address and a domain): every call is 403 ACCOUNT_NOT_ALLOWED, however often, and nothing is written.
    const elsewhere = await appWith('someone-else@mcp.test @elsewhere.test');
    for (let use = 0; use < 3; use++) {
      const refused = await call(elsewhere, c.access);
      expect(refused.status).toBe(403);
      expect(await refused.json()).toMatchObject({ code: 'ACCOUNT_NOT_ALLOWED' });
    }
    expect((await grant())?.last_used_at, 'a refusal must not stamp last_used_at').toBeNull();
    expect(await audits(), 'a refusal writes no call audit row').toBe(before);

    // A token no grant has still gets the flat 401 challenge there: the list says nothing about grants that do not exist.
    expect((await call(elsewhere, 'not-a-token')).status).toBe(401);

    // Listed by address (any letter case) or by domain: the call works and the grant is stamped as before.
    const listed = await appWith(email.toUpperCase());
    const answered = await call(listed, c.access);
    expect(answered.status).toBe(200);
    expect(await answered.json()).toMatchObject({ result: { structuredContent: { clientName: 'Test MCP client' } } });
    expect((await grant())?.last_used_at).not.toBeNull();
    expect((await call(await appWith('@mcp.test'), c.access)).status).toBe(200);

    // The list unset (the server of this suite): today's behavior, exactly.
    expect(await aboutStatus(c.access)).toBe(200);

    // Standing is not loosened by the list: a revoked grant of a listed account is refused 401, as before.
    for (const g of (await grantsOf()).filter((x) => x.id === row?.id)) expect((await rpc('mcp/grant/revoke', await asBrowser('owner'), { grantId: g.id })).status).toBe(200);
    expect((await call(listed, c.access)).status).toBe(401);

    // The definer answers the person's email for a known grant and NULL for an unknown one, to the API login only.
    const ask = async (id: string) => (await pool.query<{ email: string | null }>('SELECT ludy_kernel.mcp_grant_account_email($1::uuid) AS email', [id])).rows[0]?.email;
    expect(await ask(String(row?.id))).toBe(email);
    expect(await ask(randomUUID())).toBeNull();
  });

  // The refresh is a use of the grant too (#3223): with the list leaving the account out, the token endpoint signs no new access token.
  it('refuses a refresh and a code exchange for a grant whose account the allow-list leaves out, with invalid_grant (#3223)', async () => {
    const c = await connect();
    const port = Number(new URL(base).port);
    // The consent is the person's own browser sign-in, which the list would refuse: it is done first, and its code is traded after.
    const second = await consent('owner');
    expect(second.consentStatus).toBe(200);
    const secondCode = (await codeOf(second)).code;
    const serveWith = async (list: string | null) => {
      const config = loadConfig({ ...bootEnv, ...(list === null ? {} : { AUTH_ALLOWED_EMAILS: list }) });
      const oauth = await createOauthServer(config, (fn) => sharedRuntime.orgless(fn));
      const app = createHttpApp({ config, oauth, runtime: sharedRuntime, store: new MemoryStore(), authenticate: createAuthenticator(config, sharedDb), pool, aiEnabled: false });
      return serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }) as unknown as Server;
    };
    const swap = async (list: string | null) => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      server = await serveWith(list);
      await new Promise((resolve) => setTimeout(resolve, 100));
    };
    try {
      await swap('someone-else@mcp.test');
      const refused = await refreshWith(c.clientId, c.refresh);
      expect(refused.status).toBe(400);
      expect(refused.body.error).toBe('invalid_grant');
      expect(refused.body.access_token).toBeUndefined();
      // A code of such an account is not traded for tokens either.
      const exchanged = await tokens(second, secondCode);
      expect(exchanged.status).toBe(400);
      expect(exchanged.body.access_token).toBeUndefined();
      // The refused refresh consumed nothing: once the account is listed again the same refresh token works, and the provider's reuse detection has
      // not revoked the grant (it would, had the refresh token been consumed and a rotated one lost).
      await swap(accounts.get('owner')?.email ?? 'owner@mcp.test');
      const again = await refreshWith(c.clientId, c.refresh);
      expect(again.status).toBe(200);
      expect(await aboutStatus(String(again.body.access_token))).toBe(200);
    } finally {
      await swap(null);
    }
  });

  it('lets a member connect their own AI app once the org allows it: refused while the switch is off, a token that reads only what a member reads, and the very next call refused when the owner turns the switch off', async () => {
    const member = 'member-own-app';
    await jwt(member);
    const email = accounts.get(member)?.email;
    const invited = await rpc('org/invite', await asBrowser('owner'), { email, role: 'member' });
    expect(invited.status).toBe(200);
    expect((await rpc('invites/accept', await asBrowser(member, null), { token: String(invited.body.acceptPath).split('#')[1] })).status).toBe(200);
    const setSwitch = (on: boolean) => admin((client) => client.query(`UPDATE ludy_kernel.tenant SET mcp_member_grants = $2 WHERE org_id = $1`, [orgId, on]));
    await setSwitch(false);
    // The consent page lists the orgs where the user may connect: none for a member while the org has not allowed it.
    const before = await consent(member, orgId, 'approve', 'member');
    expect(before.details.body).toMatchObject({ orgs: [] });
    expect(before.consentStatus).toBe(403);
    // A member asking for a company grant is refused whatever the switch says.
    expect((await consent(member, orgId, 'approve', 'company')).consentStatus).toBe(403);
    await setSwitch(true);
    try {
      const c = await consent(member, orgId, 'approve', 'member');
      expect(c.details.body).toMatchObject({ orgs: [expect.objectContaining({ orgId, memberGrants: true })] });
      expect(c.consentStatus).toBe(200);
      const t = await tokens(c, (await codeOf(c)).code);
      expect(t.status).toBe(200);
      const access = String(t.body.access_token);
      expect(await aboutStatus(access)).toBe(200);
      // A member's grant reaches no owner or admin tool: the contacts tool answers an error, not data.
      const parties = await mcpModern(access, 'tools/call', { name: 'ludy_parties_list', arguments: {} }, 'ludy_parties_list');
      expect(parties.body?.error).toMatchObject({ message: 'Not allowed for this connection' });
      expect(parties.body?.result).toBeUndefined();
      await setSwitch(false);
      expect(await aboutStatus(access)).toBe(401);
    } finally {
      await setSwitch(false);
    }
  });

  it('refuses a consent by a member who is not an owner or admin, and a consent for an org the user is not in', async () => {
    const member = 'plain-member';
    await jwt(member);
    const email = accounts.get(member)?.email;
    const invited = await rpc('org/invite', await asBrowser('owner'), { email, role: 'member' });
    expect(invited.status).toBe(200);
    expect((await rpc('invites/accept', await asBrowser(member, null), { token: String(invited.body.acceptPath).split('#')[1] })).status).toBe(200);
    const refused = await consent(member);
    expect(refused.consentStatus).toBe(403);
    const stranger = await consent('stranger-with-no-org', orgId);
    expect(stranger.consentStatus).toBe(403);
    // Neither made a grant.
    expect((await grantsOf()).some((g) => g.clientName === 'Test MCP client' && g.id === undefined)).toBe(false);
  });

  it('closes access at once under the org\'s "Dung AI" and the deployment\'s AI switch, and opens it again when they are released', async () => {
    const c = await connect();
    expect(await aboutStatus(c.access)).toBe(200);
    const owner = accounts.get('owner')?.subject;
    await admin((client) => client.query(`INSERT INTO ludy_kernel.kill_switch (org_id, scope, target, engaged_by) VALUES ($1, 'org', '*', $2)`, [orgId, owner]));
    expect(await aboutStatus(c.access)).toBe(401);
    await admin((client) => client.query(`UPDATE ludy_kernel.kill_switch SET released_at = now(), released_by = engaged_by WHERE org_id = $1 AND released_at IS NULL`, [orgId]));
    expect(await aboutStatus(c.access)).toBe(200);
    await admin((client) => client.query(`SELECT ludy_kernel.global_kill_switch_set('ai', true, 'test', 'test')`));
    expect(await aboutStatus(c.access)).toBe(401);
    await admin((client) => client.query(`SELECT ludy_kernel.global_kill_switch_set('ai', false, 'test', 'test')`));
    expect(await aboutStatus(c.access)).toBe(200);
  });

  it('speaks the revisions of real clients: initialize without a session id, the version header, and the spec errors', async () => {
    const c = await connect();
    const post = (headers: Record<string, string>, body: unknown) => fetch(`${base}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${c.access}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body: JSON.stringify(body) });
    for (const version of ['2025-06-18', '2025-11-25']) {
      const init = await post({}, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: version, capabilities: {}, clientInfo: { name: 't', version: '1' } } });
      expect(init.status).toBe(200);
      expect(init.headers.get('mcp-session-id')).toBeNull();
      expect(((await init.json()) as any).result.protocolVersion).toBe(version);
      const initialized = await post({ 'mcp-protocol-version': version }, { jsonrpc: '2.0', method: 'notifications/initialized' });
      expect(initialized.status).toBe(202);
      const list = (await (await post({ 'mcp-protocol-version': version }, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).json()) as any;
      expect(list.result.tools.map((t: any) => t.name)).toEqual(['ludy_about', 'ludy_bookings_list', 'ludy_conversation', 'ludy_conversations_list', 'ludy_deal', 'ludy_deals_list', 'ludy_finance_open_balances', 'ludy_finance_overview', 'ludy_invoices_list', 'ludy_parties_list', 'ludy_payment_reminder_draft', 'ludy_projects_roadmap_demand_summary', 'ludy_projects_roadmap_ideas', 'ludy_projects_triage_summary', 'ludy_quote', 'ludy_quotes_list', 'ludy_signals', 'ludy_social_metrics_summary', 'ludy_social_metrics_totals', 'ludy_social_posts_list', 'ludy_social_review_queue']);
      for (const tool of list.result.tools) expect(tool.annotations, tool.name).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true });
      const called = (await (await post({ 'mcp-protocol-version': version }, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'ludy_about', arguments: {} } })).json()) as any;
      expect(called.result.structuredContent.clientName).toBe('Test MCP client');
      expect(called.result.resultType).toBeUndefined();
    }
    // Ignores a session id a client sends, never echoes one.
    const withSession = await post({ 'mcp-protocol-version': '2025-11-25', 'mcp-session-id': 'abc' }, { jsonrpc: '2.0', id: 4, method: 'tools/list' });
    expect(withSession.status).toBe(200);
    expect(withSession.headers.get('mcp-session-id')).toBeNull();
    // An unknown version: 400 with the versions it supports. A modern request whose header and body disagree: 400 HeaderMismatch. No version header: 400.
    const unknown = await post({ 'mcp-protocol-version': '1900-01-01' }, { jsonrpc: '2.0', id: 5, method: 'tools/list' });
    expect(unknown.status).toBe(400);
    expect(((await unknown.json()) as any).error).toMatchObject({ code: -32022, data: { supported: ['2026-07-28', '2025-11-25', '2025-06-18'], requested: '1900-01-01' } });
    const mismatch = await post({ 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/list' }, { jsonrpc: '2.0', id: 6, method: 'tools/list', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2025-11-25' } } });
    expect(mismatch.status).toBe(400);
    expect(((await mismatch.json()) as any).error.code).toBe(-32020);
    expect((await post({}, { jsonrpc: '2.0', id: 7, method: 'tools/list' })).status).toBe(400);
    const discover = await mcpModern(c.access, 'server/discover');
    expect(discover.body?.result).toMatchObject({ resultType: 'complete', supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18'], cacheScope: 'public' });
    const unknownMethod = await mcpModern(c.access, 'resources/list');
    expect(unknownMethod.status).toBe(404);
    expect(unknownMethod.body?.error.code).toBe(-32601);
    // A batch and an Origin outside the list are refused; a tool takes no arguments.
    expect((await post({ 'mcp-protocol-version': '2025-11-25' }, [{ jsonrpc: '2.0', id: 8, method: 'tools/list' }])).status).toBe(400);
    expect((await post({ origin: 'https://evil.example.com', 'mcp-protocol-version': '2025-11-25' }, { jsonrpc: '2.0', id: 9, method: 'tools/list' })).status).toBe(403);
    const withArgs = (await (await post({ 'mcp-protocol-version': '2025-11-25' }, { jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'ludy_about', arguments: { x: 1 } } })).json()) as any;
    expect(withArgs.error.code).toBe(-32602);
  });

  // Slice 1b: the data tools over the real endpoint, with arguments. The reads themselves, their projections and what they never return are pinned in mcp-data.db.test.ts.
  it('serves the data tools with checked arguments, hands an AI app the contact details an owner sees but nothing beyond them, and audits each call by tool', async () => {
    const c = await connect();
    await admin((client) => client.query(`INSERT INTO ludy_kernel.party (org_id, kind, name, email, phone, tax_code, address, source_trust) VALUES ($1, 'organization', 'Khach Hang E2E', 'e2e@customer.test', '0988 e2e phone', '0300000999', '1 Duong E2E', 'external')`, [orgId]));
    const called = await mcpModern(c.access, 'tools/call', { name: 'ludy_parties_list', arguments: { limit: 5 } }, 'ludy_parties_list');
    expect(called.status).toBe(200);
    const result = called.body?.result;
    expect(result?.isError).toBe(false);
    expect(result?.structuredContent.parties.map((p: any) => p.name)).toContain('Khach Hang E2E');
    // The owner's contacts screen shows these four, so the app gets them (owner decision 2026-11-11), with who put the row in; no other column comes with them.
    const row = result?.structuredContent.parties.find((p: any) => p.name === 'Khach Hang E2E');
    expect(row).toMatchObject({ email: 'e2e@customer.test', phone: '0988 e2e phone', address: '1 Duong E2E', taxCode: '0300000999', sourceTrust: 'external' });
    expect(Object.keys(row).sort()).toEqual(['address', 'companyName', 'createdOn', 'email', 'id', 'kind', 'name', 'phone', 'sourceTrust', 'taxCode']);
    const invoices = await mcpModern(c.access, 'tools/call', { name: 'ludy_invoices_list', arguments: {} }, 'ludy_invoices_list');
    expect(invoices.body?.result?.structuredContent).toMatchObject({ invoices: [], total: 0, truncated: false });
    // Arguments outside the schema are refused with the field's name, never its value, and before any query runs (no audit row for a call that did not run).
    const before = await admin((client) => client.query(`SELECT count(*)::int AS n FROM ludy_kernel.audit_event WHERE command = 'kernel.mcp.call'`));
    for (const bad of [{ limit: 51 }, { limit: 'many' }, { search: 'IGNORE PREVIOUS INSTRUCTIONS' }, { kind: 'x' }]) {
      const refused = await mcpModern(c.access, 'tools/call', { name: 'ludy_parties_list', arguments: bad }, 'ludy_parties_list');
      expect(refused.body?.error?.code, JSON.stringify(bad)).toBe(-32602);
      expect(JSON.stringify(refused.body)).not.toContain('IGNORE PREVIOUS');
    }
    const after = await admin((client) => client.query(`SELECT count(*)::int AS n FROM ludy_kernel.audit_event WHERE command = 'kernel.mcp.call'`));
    expect(after.rows[0].n).toBe(before.rows[0].n);
    const tools = await admin((client) => client.query(`SELECT DISTINCT detail ->> 'tool' AS tool FROM ludy_kernel.audit_event WHERE command = 'kernel.mcp.call' AND detail ->> 'mcpGrant' IS NOT NULL ORDER BY 1`));
    expect(tools.rows.map((r: any) => r.tool)).toEqual(expect.arrayContaining(['ludy_invoices_list', 'ludy_parties_list']));
    // The tool list carries each tool's JSON Schema, from the same zod schema that checks the call.
    const listed = await mcpModern(c.access, 'tools/list');
    const schema = listed.body?.result?.tools.find((t: any) => t.name === 'ludy_invoices_list')?.inputSchema;
    expect(schema).toMatchObject({ type: 'object', additionalProperties: false, properties: { direction: { enum: ['sale', 'purchase'] }, limit: { maximum: 50, minimum: 1 } } });
    expect(schema.$schema).toBeUndefined();
  });

  // Step S4 (Vy V4 and V5, #2967 and #2969): `ludy_signals` over the real endpoint. The rules and the reads themselves are pinned in signals-mcp.db.test.ts; this is the tool: its listing, an item that crosses, what
  // it says it could not check, the row budget it spends and the audit row that names it.
  it('serves ludy_signals: the items of the rules that could look, what could not be checked named, one budget row per item, and the call audited by tool', async () => {
    const c = await connect();
    const listed = await mcpModern(c.access, 'tools/list');
    const tool = listed.body?.result?.tools.find((t: any) => t.name === 'ludy_signals');
    expect(tool).toMatchObject({ title: 'Things that need attention', inputSchema: { type: 'object', additionalProperties: false, properties: {} }, annotations: { readOnlyHint: true } });
    expect(tool.description).toContain('An empty `items` means nothing was found among `checked`');
    // A deal won 8 days ago, its customer never invoiced (a stage row and a deal row, as the CRM commands write them).
    const party = (await admin((client) => client.query(`INSERT INTO ludy_kernel.party (org_id, kind, name) VALUES ($1, 'organization', 'Khach Signals E2E') RETURNING id`, [orgId]))).rows[0].id as string;
    const owner = (await admin((client) => client.query(`SELECT user_id FROM ludy_kernel.agent_grant WHERE client_id = $1`, [c.clientId]))).rows[0].user_id as string;
    const stage = (await admin((client) => client.query(`INSERT INTO ludy_crm.pipeline_stage (org_id, name, kind, position) VALUES ($1, 'Thắng', 'won', 1) RETURNING id`, [orgId]))).rows[0].id as string;
    const deal = (await admin((client) => client.query(
      `INSERT INTO ludy_crm.deal (org_id, party_id, title, amount, stage_id, sort_key, created_by, updated_by, closed_at) VALUES ($1, $2, 'Hop dong bi mat', 4200000, $3, 'a', $4, $4, now() - interval '8 days') RETURNING id`,
      [orgId, party, stage, owner],
    ))).rows[0].id as string;
    const used = async () => Number((await admin((client) => client.query(`SELECT rows_used FROM ludy_kernel.agent_grant WHERE client_id = $1`, [c.clientId]))).rows[0].rows_used ?? 0);
    const before = await used();
    const called = await mcpModern(c.access, 'tools/call', { name: 'ludy_signals', arguments: {} }, 'ludy_signals');
    expect(called.status).toBe(200);
    expect(called.body?.result?.isError).toBe(false);
    const out = called.body?.result?.structuredContent;
    expect(out.items.map((i: any) => i.id)).toEqual([`signal:won-deal-no-invoice:${deal}`]);
    expect(out.items[0]).toMatchObject({ kind: 'flag', app: 'crm', severity: 'warn', title: { key: 'signals.wonDealNoInvoice' }, amount: '4200000.00', currency: 'VND', href: '/deals' });
    // Ids, days and amounts only: the deal's title and the party's name never cross.
    expect(JSON.stringify(out)).not.toContain('bi mat');
    expect(JSON.stringify(out)).not.toContain('Khach Signals');
    // The three rules that could look are `checked` (rule 3, the supplier bank change, reads `finance.signals.supplier_bank_changes` since #3113 S1; none here, so no item).
    expect(out.checked).toEqual(['deal_without_invoice', 'receivable_with_open_deal', 'supplier_bank_changed']);
    // The conversation rule (#3124) never looks over MCP: a grant's context reads no conversation, so it is named unchecked, never an empty "all clear".
    expect(out.unchecked).toEqual([{ rule: 'conversation_unanswered', reason: 'not_available' }]);
    // One row of the daily budget per item, and the audit row names the tool.
    expect((await used()) - before).toBe(1);
    const audited = await admin((client) => client.query(`SELECT DISTINCT detail ->> 'tool' AS tool FROM ludy_kernel.audit_event WHERE command = 'kernel.mcp.call' AND detail ->> 'mcpGrant' IS NOT NULL`));
    expect(audited.rows.map((r: any) => r.tool)).toContain('ludy_signals');
    // A tool that takes no arguments refuses one, by the field's name, before any query runs.
    const refused = await mcpModern(c.access, 'tools/call', { name: 'ludy_signals', arguments: { rule: 'x' } }, 'ludy_signals');
    expect(refused.body?.error?.code).toBe(-32602);
  });

  // ADR-0032 acceptance test 2: the official MCP TypeScript client, not our own fetch calls. The client discovers the resource and the authorization server
  // from the 401 challenge, registers itself (DCR), sends the person to the authorization URL, takes the code back and then speaks 2025-11-25 (the newest
  // revision this SDK knows), with no session id. The consent step is the test's, in place of the person's browser.
  // ADR-0053, slice e (#3311): an app the org switched off leaves the tool list, and a call into it answers MODULE_OFF as an error result the model can read; the grant stays authorized.
  it('leaves the tools of an app the org switched off out of tools/list and answers a call into one with MODULE_OFF as isError, until it is switched back on', async () => {
    const c = await connect();
    const ownerId = (await admin((client) => client.query(`SELECT user_id FROM ludy_kernel.tenant_member WHERE org_id = $1 AND role = 'owner'`, [orgId]))).rows[0].user_id as string;
    const owner = { type: 'user' as const, userId: ownerId, aal: 'aal2' as const, sessionId: '7e1c2b4a-5d6f-4a8b-9c0d-1e2f3a4b5c6d', mfaAt: Math.floor(Date.now() / 1000) };
    const setApp = (enabled: boolean) => sharedRuntime.execute('kernel.org.set_app', { module: 'social', enabled }, { actor: owner, orgId, idempotencyKey: randomUUID() });
    const names = async () => (((await mcpModern(c.access, 'tools/list')).body?.result?.tools ?? []) as Array<{ name: string }>).map((t) => t.name);
    expect(await names()).toEqual(expect.arrayContaining(['ludy_social_posts_list', 'ludy_social_review_queue']));
    await setApp(false);
    try {
      const listed = await names();
      expect(listed).not.toContain('ludy_social_posts_list');
      expect(listed).not.toContain('ludy_social_review_queue');
      // The other tools are untouched.
      expect(listed).toEqual(expect.arrayContaining(['ludy_about', 'ludy_parties_list', 'ludy_invoices_list', 'ludy_signals']));
      const called = await mcpModern(c.access, 'tools/call', { name: 'ludy_social_posts_list', arguments: {} }, 'ludy_social_posts_list');
      expect(called.status).toBe(200);
      expect(called.body?.error).toBeUndefined();
      expect(called.body?.result?.isError).toBe(true);
      expect(called.body?.result?.content?.[0]?.text).toContain('MODULE_OFF');
      expect(called.body?.result?.content?.[0]?.text).toContain('social');
      // The call is audited as refused, and the grant still reads the apps that are on.
      const audited = await admin((client) => client.query(`SELECT detail ->> 'result' AS outcome FROM ludy_kernel.audit_event WHERE org_id = $1 AND command = 'kernel.mcp.call' AND detail ->> 'tool' = 'ludy_social_posts_list' AND detail ->> 'result' = 'refused' LIMIT 1`, [orgId]));
      expect(audited.rows[0]?.outcome).toBe('refused');
      // The listing carries no internal field of the descriptor.
      const raw = (await mcpModern(c.access, 'tools/list')).body?.result?.tools as Array<Record<string, unknown>>;
      expect(raw.every((t) => !('module' in t))).toBe(true);
      const about = await mcpModern(c.access, 'tools/call', { name: 'ludy_about', arguments: {} }, 'ludy_about');
      expect(about.body?.result?.isError).toBe(false);
    } finally {
      await setApp(true);
    }
    expect(await names()).toEqual(expect.arrayContaining(['ludy_social_posts_list', 'ludy_social_review_queue']));
    const back = await mcpModern(c.access, 'tools/call', { name: 'ludy_social_posts_list', arguments: {} }, 'ludy_social_posts_list');
    expect(back.body?.result?.isError).toBe(false);
  });

  it('works with the official MCP TypeScript SDK client: discovery, registration, consent, token, tools/list and a tool call', async () => {
    const callback = 'http://127.0.0.1:39998/callback';
    let info: { client_id: string } | undefined;
    let saved: Record<string, unknown> | undefined;
    let verifier = '';
    let authUrl: URL | undefined;
    const provider: OAuthClientProvider = {
      get redirectUrl() {
        return callback;
      },
      get clientMetadata() {
        return { client_name: 'SDK client', redirect_uris: [callback], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', application_type: 'native' as const };
      },
      clientInformation: () => info as never,
      saveClientInformation: (value) => {
        info = value as never;
      },
      tokens: () => saved as never,
      saveTokens: (value) => {
        saved = value as never;
      },
      redirectToAuthorization: (url) => {
        authUrl = url;
      },
      saveCodeVerifier: (value) => {
        verifier = value;
      },
      codeVerifier: () => verifier,
    };
    const transport = new StreamableHTTPClientTransport(new URL(resource), { authProvider: provider });
    const first = new McpClient({ name: 'sdk-test', version: '1.0.0' });
    await expect(first.connect(transport)).rejects.toBeInstanceOf(UnauthorizedError);
    expect(info?.client_id, 'the client registered itself').toBeTruthy();
    expect(authUrl, 'the client sent the person to the authorization URL').toBeDefined();
    const asked = authUrl as URL;
    expect(asked.searchParams.get('resource')).toBe(resource);
    expect(asked.searchParams.get('code_challenge_method')).toBe('S256');
    expect(asked.searchParams.get('scope'), 'the client asks for the scope the resource metadata advertises').toBe('ludy.read');
    // The person's part: the consent page, answered as the owner.
    const started = await fetch(asked, { redirect: 'manual' });
    expect(started.status).toBe(303);
    const uid = new URL(started.headers.get('location') ?? '', base).pathname.split('/').pop() as string;
    const headers = { ...(await asBrowser('owner', null)), cookie: cookiesOf(started) };
    const approved = await fetch(`${base}/oauth/interaction/${uid}/consent`, { method: 'POST', headers, body: JSON.stringify({ decision: 'approve', orgId }) });
    expect(approved.status).toBe(200);
    const resumed = await fetch(((await approved.json()) as { redirectTo: string }).redirectTo, { redirect: 'manual', headers: { cookie: cookiesOf(started) } });
    const back = new URL(resumed.headers.get('location') ?? 'http://none/', base);
    expect(back.searchParams.get('state')).toBe(asked.searchParams.get('state'));
    await transport.finishAuth(back.searchParams.get('code') as string);
    expect(typeof saved?.access_token).toBe('string');
    // A fresh client over a fresh transport, with the saved token.
    const client = new McpClient({ name: 'sdk-test', version: '1.0.0' });
    const second = new StreamableHTTPClientTransport(new URL(resource), { authProvider: provider });
    await client.connect(second);
    expect(second.protocolVersion, 'the newest revision this SDK knows').toBe('2025-11-25');
    expect(second.sessionId, 'the server never mints a session').toBeUndefined();
    expect(client.getServerVersion()?.name).toBe('ludy');
    expect(client.getServerCapabilities()?.tools).toBeDefined();
    const listed = await client.listTools();
    expect(listed.tools.map((t) => t.name)).toEqual(['ludy_about', 'ludy_bookings_list', 'ludy_conversation', 'ludy_conversations_list', 'ludy_deal', 'ludy_deals_list', 'ludy_finance_open_balances', 'ludy_finance_overview', 'ludy_invoices_list', 'ludy_parties_list', 'ludy_payment_reminder_draft', 'ludy_projects_roadmap_demand_summary', 'ludy_projects_roadmap_ideas', 'ludy_projects_triage_summary', 'ludy_quote', 'ludy_quotes_list', 'ludy_signals', 'ludy_social_metrics_summary', 'ludy_social_metrics_totals', 'ludy_social_posts_list', 'ludy_social_review_queue']);
    expect(listed.tools[0]?.annotations).toMatchObject({ readOnlyHint: true });
    const called = await client.callTool({ name: 'ludy_about', arguments: {} });
    expect(called.isError).toBeFalsy();
    expect(called.structuredContent).toMatchObject({ clientName: 'SDK client', scopes: ['ludy.read'] });
    await client.close();
    // The tool call it made is in the audit log under its grant (a tool call is what is audited, not the handshake or the list).
    const rows = await admin((c) => c.query(`SELECT detail FROM ludy_kernel.audit_event WHERE command = 'kernel.mcp.call' AND detail ->> 'mcpClientName' = 'SDK client'`));
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].detail).toMatchObject({ mcpCall: true, tool: 'ludy_about', result: 'ok' });
  });

  it('accepts only the registrations the rules allow: no wildcard or plain http redirect on the web, no secret, no other grant', async () => {
    const attempt = (body: Record<string, unknown>) => fetch(`${base}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'x', token_endpoint_auth_method: 'none', application_type: 'web', ...body }) });
    expect((await attempt({ redirect_uris: ['http://app.example.com/cb'] })).status).toBe(400);
    expect((await attempt({ redirect_uris: ['https://app.example.com/*'] })).status).toBe(400);
    expect((await attempt({ redirect_uris: ['https://app.example.com/cb'], token_endpoint_auth_method: 'client_secret_basic' })).status).toBe(400);
    expect((await attempt({ redirect_uris: ['https://app.example.com/cb'], grant_types: ['client_credentials'] })).status).toBe(400);
    const good = await attempt({ redirect_uris: ['https://app.example.com/cb'] });
    expect(good.status).toBe(201);
  });

  it('refuses a request with no PKCE challenge, the plain method, a wrong resource and a redirect that is not registered', async () => {
    const reg = await register();
    const clientId = String(reg.body.client_id);
    const verifier = randomBytes(32).toString('base64url');
    const ask = async (overrides: Record<string, string | undefined>) => {
      const params: Record<string, string> = { client_id: clientId, response_type: 'code', redirect_uri: reg.redirect, scope: 'ludy.read', resource, code_challenge: challengeOf(verifier), code_challenge_method: 'S256', state: 's' };
      for (const [k, v] of Object.entries(overrides)) {
        if (v === undefined) delete params[k];
        else params[k] = v;
      }
      const response = await fetch(`${base}/oauth/authorize?${new URLSearchParams(params)}`, { redirect: 'manual' });
      return { status: response.status, location: response.headers.get('location') ?? '' };
    };
    const noPkce = await ask({ code_challenge: undefined, code_challenge_method: undefined });
    expect(noPkce.location).toContain('error=invalid_request');
    const plain = await ask({ code_challenge_method: 'plain' });
    expect(plain.location).toContain('error=invalid_request');
    const wrongResource = await ask({ resource: 'https://other.example.com/mcp' });
    expect(wrongResource.location).toContain('error=invalid_target');
    const otherRedirect = await ask({ redirect_uri: 'http://127.0.0.1:1/other' });
    expect(otherRedirect.location).not.toContain('code=');
    expect(otherRedirect.location).not.toContain('127.0.0.1:1/other');
  });

  it('does not fetch a client metadata document from a private, loopback or link-local address', async () => {
    for (const clientId of ['https://127.0.0.1/client.json', 'https://localhost/client.json', 'https://169.254.169.254/client.json', 'https://10.0.0.5/client.json', 'http://example.com/client.json']) {
      const response = await fetch(`${base}/oauth/authorize?${new URLSearchParams({ client_id: clientId, response_type: 'code', redirect_uri: 'http://127.0.0.1:39999/callback', scope: 'ludy.read', resource, code_challenge: challengeOf('x'.repeat(43)), code_challenge_method: 'S256' })}`, { redirect: 'manual' });
      expect(response.status, clientId).toBeGreaterThanOrEqual(400);
      expect(response.headers.get('location') ?? '').not.toContain('/oauth/interaction/');
    }
  });

  it('writes an audit row for every call that names the grant, the client and the tool, and says it came over MCP', async () => {
    const c = await connect();
    await mcpModern(c.access, 'tools/call', { name: 'ludy_about', arguments: {} }, 'ludy_about');
    const rows = await admin(async (client) => (await client.query(`SELECT actor_type, actor_id, command, detail FROM ludy_kernel.audit_event WHERE command = 'kernel.mcp.call' AND detail ->> 'mcpClientName' = 'Test MCP client' ORDER BY id DESC LIMIT 1`)).rows);
    expect(rows[0]).toMatchObject({ actor_type: 'system', actor_id: null, command: 'kernel.mcp.call' });
    expect(rows[0].detail).toMatchObject({ mcpCall: true, tool: 'ludy_about', result: 'ok' });
    expect(rows[0].detail.mcpGrant).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(rows[0].detail)).not.toContain(c.access);
  });

  it('answers 429 once a grant spends its minute, before any query runs', async () => {
    const c = await connect();
    let limited = 0;
    for (let i = 0; i < 90; i += 1) if ((await aboutStatus(c.access)) === 429) limited += 1;
    expect(limited).toBeGreaterThan(0);
  });

  it('stops a grant that has read its day\'s rows: the call that crosses the line is answered, the next is refused before any query runs and audited as rate limited, and a new day starts at zero', async () => {
    const c = await connect();
    const grantId = (await admin((client) => client.query(`SELECT id FROM ludy_kernel.agent_grant WHERE client_id = $1 AND revoked_at IS NULL`, [c.clientId]))).rows[0].id as string;
    await admin((client) => client.query(`INSERT INTO ludy_kernel.party (org_id, kind, name, source_trust) VALUES ($1, 'organization', 'Budget Kh 1', 'external'), ($1, 'organization', 'Budget Kh 2', 'external')`, [orgId]));
    const limit = 2000;
    await admin((client) => client.query(`UPDATE ludy_kernel.agent_grant SET rows_day = (now() AT TIME ZONE 'UTC')::date, rows_used = $2 WHERE id = $1`, [grantId, limit - 1]));
    const crossing = await mcpModern(c.access, 'tools/call', { name: 'ludy_parties_list', arguments: { limit: 5 } }, 'ludy_parties_list');
    expect(crossing.body?.result?.isError).toBe(false);
    const used = await admin((client) => client.query(`SELECT rows_used FROM ludy_kernel.agent_grant WHERE id = $1`, [grantId]));
    expect(used.rows[0].rows_used).toBeGreaterThan(limit);
    const refused = await mcpModern(c.access, 'tools/call', { name: 'ludy_parties_list', arguments: { limit: 5 } }, 'ludy_parties_list');
    expect(refused.body?.error?.message).toContain('daily limit');
    expect(JSON.stringify(refused.body)).not.toContain('Budget Kh');
    // Every tool is refused once the day's rows are spent (the check runs before the query), and the refusal is in the audit as rate limited.
    expect((await mcpModern(c.access, 'tools/call', { name: 'ludy_about', arguments: {} }, 'ludy_about')).body?.error?.message).toContain('daily limit');
    const audit = await admin((client) => client.query(`SELECT detail ->> 'result' AS result FROM ludy_kernel.audit_event WHERE command = 'kernel.mcp.call' AND detail ->> 'mcpGrant' = $1 AND detail ->> 'tool' = 'ludy_parties_list' ORDER BY id DESC LIMIT 1`, [grantId]));
    expect(audit.rows[0].result).toBe('rate_limited');
    // Yesterday's counter does not count today.
    await admin((client) => client.query(`UPDATE ludy_kernel.agent_grant SET rows_day = (now() AT TIME ZONE 'UTC')::date - 1 WHERE id = $1`, [grantId]));
    expect((await mcpModern(c.access, 'tools/call', { name: 'ludy_parties_list', arguments: { limit: 5 } }, 'ludy_parties_list')).body?.result?.isError).toBe(false);
  });

  // A second server over the same database, with other limits, for the tests that need a budget they can spend.
  async function secondServer(env: Record<string, string>) {
    const port = await freePort();
    const url = `http://localhost:${port}`;
    const second = loadConfig({ ...bootEnv, ...env, PUBLIC_URL: url });
    const oauth = await createOauthServer(second, (fn) => sharedRuntime.orgless(fn));
    const app = createHttpApp({ config: second, oauth, runtime: sharedRuntime, store: new MemoryStore(), authenticate: createAuthenticator(second, sharedDb), pool, aiEnabled: false });
    const running = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }) as unknown as Server;
    await new Promise((resolve) => setTimeout(resolve, 100));
    return { url, close: () => running.close() };
  }

  it('gives the provider routes what the global chain gives the others: request id, security headers, CORS, body limit', async () => {
    // Security headers and a request id on the metadata, and no-store plus the same on a token refusal.
    for (const path of ['/.well-known/openid-configuration', '/.well-known/oauth-authorization-server', '/oauth/jwks']) {
      const response = await fetch(`${base}${path}`);
      expect(response.status, path).toBe(200);
      expect(response.headers.get('x-content-type-options'), path).toBe('nosniff');
      expect(response.headers.get('referrer-policy'), path).toBe('no-referrer');
      expect(response.headers.get('x-frame-options'), path).toBe('DENY');
      expect(response.headers.get('content-security-policy'), path).toContain("frame-ancestors 'none'");
      expect(response.headers.get('x-request-id'), path).toMatch(/^[0-9a-f-]{36}$/);
      // No origin outside the list gets a CORS header, not even on the public metadata (the provider's own `*` is dropped).
      expect(response.headers.get('access-control-allow-origin'), path).toBeNull();
      expect(response.headers.get('access-control-allow-credentials'), path).toBeNull();
    }
    const token = await fetch(`${base}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'grant_type=authorization_code&code=x' });
    expect(token.status).toBeGreaterThanOrEqual(400);
    expect(token.headers.get('cache-control')).toContain('no-store');
    expect(token.headers.get('x-content-type-options')).toBe('nosniff');
    expect(token.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
    expect(token.headers.get('access-control-allow-origin')).toBeNull();
    // The request ids are fresh per request, never taken from the caller.
    const sent = await fetch(`${base}/oauth/jwks`, { headers: { 'x-request-id': 'attacker-chosen' } });
    expect(sent.headers.get('x-request-id')).not.toBe('attacker-chosen');
    // CORS: an exact allowlist, no credentials; a preflight is answered; another origin gets no header.
    const allowed = await fetch(`${base}/.well-known/openid-configuration`, { headers: { origin: 'https://allowed.example.com' } });
    expect(allowed.headers.get('access-control-allow-origin')).toBe('https://allowed.example.com');
    expect(allowed.headers.get('access-control-allow-credentials')).toBeNull();
    const other = await fetch(`${base}/oauth/token`, { method: 'POST', headers: { origin: 'https://evil.example.com', 'content-type': 'application/x-www-form-urlencoded' }, body: 'grant_type=x' });
    expect(other.headers.get('access-control-allow-origin')).toBeNull();
    const preflight = await fetch(`${base}/oauth/token`, { method: 'OPTIONS', headers: { origin: 'https://allowed.example.com', 'access-control-request-method': 'POST' } });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('https://allowed.example.com');
    expect(preflight.headers.get('access-control-allow-methods')).toContain('POST');
    const badPreflight = await fetch(`${base}/oauth/token`, { method: 'OPTIONS', headers: { origin: 'https://evil.example.com' } });
    expect(badPreflight.status).toBe(204);
    expect(badPreflight.headers.get('access-control-allow-origin')).toBeNull();
    // A body over 64 KB is refused before the provider reads it, with the same headers.
    const big = await fetch(`${base}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'x'.repeat(70_000) }) });
    expect(big.status).toBe(413);
    expect(big.headers.get('x-content-type-options')).toBe('nosniff');
    expect(big.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
    const bigMcp = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer x' }, body: 'x'.repeat(70_000) });
    expect(bigMcp.status).toBe(413);
  });

  it('logs one access line per provider request with the route pattern and never a code, token or verifier', async () => {
    const lines: string[] = [];
    const restore = installJsonLogs({ role: 'api', write: (_level, line) => void lines.push(line) });
    let c: Awaited<ReturnType<typeof connect>>;
    try {
      c = await connect();
    } finally {
      restore();
    }
    const text = lines.join('');
    expect(text).toContain('"route":"/oauth/token"');
    expect(text).toContain('"route":"/oauth/authorize"');
    for (const secret of [c.code, c.refresh, c.access, c.verifier]) expect(text).not.toContain(secret);
  });

  it('limits registrations per address and in all, and the provider routes per address, with 429 and Retry-After', async () => {
    await admin((client) => client.query('DELETE FROM ludy_kernel.mcp_rate_limit'));
    const s = await secondServer({ OAUTH_REGISTER_PER_MINUTE: '2', OAUTH_REGISTER_GLOBAL_PER_MINUTE: '50' });
    try {
      const register = () => fetch(`${s.url}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'x', redirect_uris: ['http://127.0.0.1:39999/cb'], application_type: 'native', token_endpoint_auth_method: 'none' }) });
      const statuses: number[] = [];
      for (let i = 0; i < 5; i += 1) statuses.push((await register()).status);
      expect(statuses.slice(0, 2)).toEqual([201, 201]);
      const limited = await register();
      expect(limited.status).toBe(429);
      expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
      expect(limited.headers.get('x-content-type-options')).toBe('nosniff');
    } finally {
      s.close();
      await admin((client) => client.query('DELETE FROM ludy_kernel.mcp_rate_limit'));
    }
  });

  it('refuses the registrations that would make the server fetch for a stranger, or that are not OAuth 2.1, or that are big', async () => {
    const attempt = (body: Record<string, unknown>) => fetch(`${base}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'x', token_endpoint_auth_method: 'none', application_type: 'web', redirect_uris: ['https://app.example.com/cb'], ...body }) });
    for (const extra of [
      { sector_identifier_uri: 'https://big.example/x' },
      { jwks_uri: 'https://big.example/jwks' },
      { initiate_login_uri: 'https://app.example.com/login' },
      { response_types: ['code id_token'], grant_types: ['implicit', 'authorization_code'] },
      { client_name: 'n'.repeat(121) },
      { redirect_uris: Array.from({ length: 6 }, (_, i) => `https://app.example.com/cb${i}`) },
      { contacts: Array.from({ length: 300 }, (_, i) => `person${i}@example.com`) },
    ]) {
      expect((await attempt(extra)).status, JSON.stringify(extra).slice(0, 60)).toBe(400);
    }
    const meta = (await (await fetch(`${base}/.well-known/openid-configuration`)).json()) as Record<string, unknown>;
    expect(meta.response_types_supported).toEqual(['code']);
    expect(meta.grant_types_supported).toEqual(expect.not.arrayContaining(['implicit']));
    expect(meta.pushed_authorization_request_endpoint).toBeUndefined();
    expect(meta.end_session_endpoint).toBeUndefined();
    expect(meta.dpop_signing_alg_values_supported).toBeUndefined();
  });

  it('answers a client that also asks for openid with a code, not with a second consent page', async () => {
    const reg = await register();
    const clientId = String(reg.body.client_id);
    const verifier = randomBytes(32).toString('base64url');
    const url = new URL(`${base}/oauth/authorize`);
    url.search = new URLSearchParams({ client_id: clientId, response_type: 'code', redirect_uri: reg.redirect, scope: 'openid ludy.read', resource, code_challenge: challengeOf(verifier), code_challenge_method: 'S256', state: 's' }).toString();
    const started = await fetch(url, { redirect: 'manual' });
    const uid = new URL(started.headers.get('location') ?? '', base).pathname.split('/').pop() as string;
    const headers = { ...(await asBrowser('owner', null)), cookie: cookiesOf(started) };
    const approved = await fetch(`${base}/oauth/interaction/${uid}/consent`, { method: 'POST', headers, body: JSON.stringify({ decision: 'approve', orgId }) });
    const answer = (await approved.json()) as { redirectTo: string };
    const resumed = await fetch(answer.redirectTo, { redirect: 'manual', headers: { cookie: cookiesOf(started) } });
    expect(new URL(resumed.headers.get('location') ?? 'http://none/', base).searchParams.get('code')).toBeTruthy();
  });

  it('gives a code and a refresh token to one request only when two race with it', async () => {
    const c = await connect();
    const results = await Promise.all([refreshWith(c.clientId, c.refresh), refreshWith(c.clientId, c.refresh)]);
    expect(results.filter((r) => r.status === 200).length).toBeLessThanOrEqual(1);
  });

  // The one MCP write (#3227): the choice on the consent page, the token, the tool list and the draft it makes, end to end.
  const DRAFT = 'ludy.social.draft';
  const claimsOf = (access: string) => JSON.parse(Buffer.from(access.split('.')[1] as string, 'base64url').toString()) as { scope: string };
  async function draftGrant(opts: { scope?: string; draft?: boolean; kind?: 'company' | 'member'; owner?: string } = {}) {
    const c = await consent(opts.owner ?? 'owner', orgId, 'approve', opts.kind, { scope: opts.scope ?? `ludy.read ${DRAFT}`, ...(opts.draft !== undefined ? { draft: opts.draft } : {}) });
    return c;
  }
  async function tokenOf(c: Awaited<ReturnType<typeof consent>>) {
    expect(c.consentStatus).toBe(200);
    const { code } = await codeOf(c);
    expect(code).not.toBe('');
    const t = await tokens(c, code);
    expect(t.status).toBe(200);
    return String(t.body.access_token);
  }
  const toolNames = async (access: string) => ((((await mcpModern(access, 'tools/list')).body?.result?.tools ?? []) as Array<{ name: string }>)).map((t) => t.name);

  it('lets an owner tick the draft scope: the page offers it, the token and the grant hold it, the write tool is listed, and a draft is an AI post made over MCP', async () => {
    const c = await draftGrant({ draft: true });
    expect(c.details.body).toMatchObject({ scopes: ['ludy.read', DRAFT] });
    const access = await tokenOf(c);
    expect(claimsOf(access).scope.split(' ').sort()).toEqual(['ludy.read', DRAFT]);
    const row = await admin((client) => client.query(`SELECT scopes, kind FROM ludy_kernel.agent_grant WHERE client_id = $1`, [c.clientId]));
    expect(row.rows[0]).toEqual({ scopes: ['ludy.read', DRAFT], kind: 'company' });
    const list = ((await mcpModern(access, 'tools/list')).body?.result?.tools ?? []) as Array<{ name: string; annotations: Record<string, boolean> }>;
    const tool = list.find((t) => t.name === 'ludy_social_draft_create');
    expect(tool?.annotations).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });
    const connectionId = randomUUID();
    await admin((client) => client.query(`INSERT INTO ludy_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) SELECT $1, $2, 'sandbox', 'acct-mcp-draft', 'Kênh thử', user_id FROM ludy_kernel.tenant_member WHERE org_id = $1 AND role = 'owner' LIMIT 1`, [orgId, connectionId]));
    const made = await mcpModern(access, 'tools/call', { name: 'ludy_social_draft_create', arguments: { body: 'Bài do ứng dụng AI soạn', channels: [{ connectionId }] } }, 'ludy_social_draft_create');
    expect(made.status).toBe(200);
    const result = made.body?.result?.structuredContent as { postId: string; status: string; variants: Array<Record<string, string>> };
    expect(result).toMatchObject({ status: 'draft', revision: 1 });
    expect(Object.keys(result.variants[0] as object).sort()).toEqual(['connectionId', 'variantId']);
    const post = await admin((client) => client.query(`SELECT origin, actor_origin, tainted, status FROM ludy_social.post WHERE id = $1`, [result.postId]));
    expect(post.rows[0]).toEqual({ origin: 'ai', actor_origin: 'mcp', tainted: true, status: 'draft' });
    // The call is audited by tool as the grant's, and the read tools still work for the same grant.
    const audit = await admin((client) => client.query(`SELECT detail FROM ludy_kernel.audit_event WHERE command = 'kernel.mcp.call' AND detail ->> 'tool' = 'ludy_social_draft_create' ORDER BY id DESC LIMIT 1`));
    expect(audit.rows[0].detail).toMatchObject({ mcpCall: true, result: 'ok', mcpClientName: 'Test MCP client' });
    const seen = await mcpModern(access, 'tools/call', { name: 'ludy_social_posts_list', arguments: {} }, 'ludy_social_posts_list');
    const seenPosts = (seen.body?.result?.structuredContent ?? { posts: [] }) as { posts: Array<{ id: string }> };
    expect(seenPosts.posts.map((p) => p.id)).toContain(result.postId);
    // A bad argument names the field, and a field outside the schema (a channel's own settings, media or link) is refused before anything runs.
    const bad = await mcpModern(access, 'tools/call', { name: 'ludy_social_draft_create', arguments: { body: 'x', channels: [{ connectionId, settings: { removeAt: '2030-01-01T00:00:00Z' } }] } }, 'ludy_social_draft_create');
    expect(bad.body?.error?.message).toMatch(/Invalid arguments/);
  });

  it('keeps the draft scope off unless the person ticks it: the same request with the box left clear gets a code, a read-only token and no write tool', async () => {
    for (const draft of [false, undefined]) {
      const c = await draftGrant(draft === undefined ? {} : { draft });
      const access = await tokenOf(c);
      expect(claimsOf(access).scope).toBe('ludy.read');
      expect((await admin((client) => client.query(`SELECT scopes FROM ludy_kernel.agent_grant WHERE client_id = $1`, [c.clientId]))).rows[0].scopes).toEqual(['ludy.read']);
      expect(await toolNames(access)).not.toContain('ludy_social_draft_create');
      const refused = await mcpModern(access, 'tools/call', { name: 'ludy_social_draft_create', arguments: { body: 'x', channels: [{ connectionId: randomUUID() }] } }, 'ludy_social_draft_create');
      expect(refused.body?.error?.message).toBe('Unknown tool');
    }
  });

  it('refuses the draft scope a client did not ask for and one asked for a member grant, and offers a read-only client nothing', async () => {
    const readOnly = await consent('owner', orgId, 'approve', undefined, { draft: true });
    expect(readOnly.details.body).toMatchObject({ scopes: ['ludy.read'] });
    expect(readOnly.consentStatus).toBe(422);
    const asMember = await draftGrant({ draft: true, kind: 'member' });
    expect(asMember.consentStatus).toBe(422);
    // A client that asks for the draft scope alone is offered the read scope only, and cannot tick a draft grant that would hold no read scope.
    const draftOnly = await draftGrant({ scope: DRAFT, draft: true });
    expect(draftOnly.details.body).toMatchObject({ scopes: ['ludy.read'] });
    expect(draftOnly.consentStatus).toBe(422);
    // Nothing half made is left: no grant of those clients.
    for (const c of [readOnly, asMember, draftOnly]) {
      expect((await admin((client) => client.query(`SELECT count(*)::int AS n FROM ludy_kernel.agent_grant WHERE client_id = $1`, [c.clientId]))).rows[0].n).toBe(0);
    }
  });

  // The per-line write scopes (ADR-0051 decision 11, #3858): each is ticked on its own, held only by a company grant with the read scope, and lists the tools of its commands (E2, #3861).
  const ENGAGE = 'ludy.engage.write';
  const ADS = 'ludy.ads.draft';
  const ALL_WRITES = `ludy.read ${DRAFT} ${ENGAGE} ${ADS}`;

  it('lets an owner tick the Engage and Ads write scopes one by one: the page offers all three, the token and the grant hold exactly the ticked ones, and the tools of the ticked scope are listed', async () => {
    const asked = await consent('owner', orgId, 'approve', undefined, { scope: ALL_WRITES, writes: [ENGAGE] });
    expect(asked.details.body).toMatchObject({ scopes: ['ludy.read', DRAFT, ENGAGE, ADS] });
    const access = await tokenOf(asked);
    expect(claimsOf(access).scope.split(' ').sort()).toEqual(['ludy.engage.write', 'ludy.read']);
    expect((await admin((client) => client.query(`SELECT scopes, kind FROM ludy_kernel.agent_grant WHERE client_id = $1`, [asked.clientId]))).rows[0]).toEqual({ scopes: ['ludy.engage.write', 'ludy.read'], kind: 'company' });
    // The tool list is filtered by scope: the Social draft tool is not listed for a grant that does not hold its scope.
    const names = await toolNames(access);
    expect(names).not.toContain('ludy_social_draft_create');
    expect(names).toContain('ludy_about');
    const both = await tokenOf(await consent('owner', orgId, 'approve', undefined, { scope: ALL_WRITES, writes: [DRAFT, ADS] }));
    expect(claimsOf(both).scope.split(' ').sort()).toEqual(['ludy.ads.draft', 'ludy.read', DRAFT]);
    expect(await toolNames(both)).toContain('ludy_social_draft_create');
    // Ticking nothing leaves the read scope alone, whatever the client asked for.
    const none = await tokenOf(await consent('owner', orgId, 'approve', undefined, { scope: ALL_WRITES, writes: [] }));
    expect(claimsOf(none).scope).toBe('ludy.read');
  });

  it('works an inbox thread through the endpoint with the Engage scope: the tools are listed for it alone, a note and a contact land, and the calls are audited by tool and as the grant\'s (#3861)', async () => {
    const engageOnly = await tokenOf(await consent('owner', orgId, 'approve', undefined, { scope: ALL_WRITES, writes: [ENGAGE] }));
    const names = await toolNames(engageOnly);
    for (const name of ['ludy_conversation_assign', 'ludy_conversation_resolve', 'ludy_conversation_reopen', 'ludy_conversation_note', 'ludy_conversation_link_contact', 'ludy_party_create', 'ludy_deal_create', 'ludy_deal_move', 'ludy_quote_save', 'ludy_quote_revise', 'ludy_next_step_done', 'ludy_next_step_snooze']) expect(names, name).toContain(name);
    expect(names).not.toContain('ludy_ads_campaign_draft_save');
    expect(names).not.toContain('ludy_social_draft_create');
    // A read-only grant is offered none of them and a call to one is an unknown tool.
    const readOnly = await tokenOf(await consent('owner', orgId, 'approve', undefined, { scope: ALL_WRITES, writes: [] }));
    expect(await toolNames(readOnly)).not.toContain('ludy_conversation_note');
    expect((await mcpModern(readOnly, 'tools/call', { name: 'ludy_conversation_note', arguments: {} }, 'ludy_conversation_note')).body?.error?.message).toBe('Unknown tool');
    // A thread of the org, and the writes through the tools.
    const [connection, identity, thread] = [randomUUID(), randomUUID(), randomUUID()];
    await admin((client) => client.query(`INSERT INTO ludy_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) SELECT $1, $2, 'facebook_page', 'acct-engage-e2e', 'Trang thử', user_id FROM ludy_kernel.tenant_member WHERE org_id = $1 AND role = 'owner' LIMIT 1`, [orgId, connection]));
    await admin((client) => client.query(`INSERT INTO ludy_kernel.conversation_identity (org_id, id, provider, external_user_id, display_name) VALUES ($1, $2, 'facebook', 'u-e2e-12345678', 'Khách')`, [orgId, identity]));
    await admin((client) => client.query(`INSERT INTO ludy_kernel.conversation (org_id, id, channel_connection_id, kind, external_thread_id, identity_id, last_seq, last_message_at, last_inbound_at) VALUES ($1, $2, $3, 'comment_thread', 't-e2e', $4, 1, now(), now())`, [orgId, thread, connection, identity]));
    const noted = await mcpModern(engageOnly, 'tools/call', { name: 'ludy_conversation_note', arguments: { conversationId: thread, body: 'Khách hỏi giá (Dy)' } }, 'ludy_conversation_note');
    expect(noted.status).toBe(200);
    const noteId = ((noted.body?.result?.structuredContent ?? {}) as { noteId: string }).noteId;
    expect((await admin((client) => client.query(`SELECT body FROM ludy_kernel.conversation_note WHERE id = $1`, [noteId]))).rows[0].body).toBe('Khách hỏi giá (Dy)');
    const made = await mcpModern(engageOnly, 'tools/call', { name: 'ludy_party_create', arguments: { kind: 'person', name: 'Khách qua MCP' } }, 'ludy_party_create');
    const partyId = ((made.body?.result?.structuredContent ?? {}) as { partyId: string }).partyId;
    expect((await admin((client) => client.query(`SELECT source_trust FROM ludy_kernel.party WHERE id = $1`, [partyId]))).rows[0].source_trust).toBe('external');
    const resolved = await mcpModern(engageOnly, 'tools/call', { name: 'ludy_conversation_resolve', arguments: { conversationId: thread } }, 'ludy_conversation_resolve');
    expect(resolved.body?.result?.structuredContent).toEqual({ conversationId: thread });
    expect((await admin((client) => client.query(`SELECT status FROM ludy_kernel.conversation WHERE id = $1`, [thread]))).rows[0].status).toBe('resolved');
    // A field outside the schema is refused before anything runs.
    const bad = await mcpModern(engageOnly, 'tools/call', { name: 'ludy_conversation_note', arguments: { conversationId: thread, body: 'x', authorUserId: randomUUID() } }, 'ludy_conversation_note');
    expect(bad.body?.error?.message).toMatch(/Invalid arguments/);
    // Every call is audited by tool (the endpoint's row) and as the grant's (the command's row, naming the client).
    for (const [tool, command] of [['ludy_conversation_note', 'kernel.mcp.conversation_note'], ['ludy_party_create', 'kernel.mcp.party_create'], ['ludy_conversation_resolve', 'kernel.mcp.conversation_resolve']] as const) {
      const call = await admin((client) => client.query(`SELECT detail FROM ludy_kernel.audit_event WHERE command = 'kernel.mcp.call' AND detail ->> 'tool' = $1 ORDER BY id DESC LIMIT 1`, [tool]));
      expect(call.rows[0].detail, tool).toMatchObject({ mcpCall: true, result: 'ok', mcpClientName: 'Test MCP client' });
      const row = await admin((client) => client.query(`SELECT outcome, detail FROM ludy_kernel.audit_event WHERE command = $1 ORDER BY id DESC LIMIT 1`, [command]));
      expect(row.rows[0], command).toMatchObject({ outcome: 'ok', detail: { mcpCall: true, mcpClientName: 'Test MCP client' } });
      expect(typeof row.rows[0].detail.mcpGrant, command).toBe('string');
    }
  });

  it('refuses a write scope the client did not ask for, one asked for a member grant, and the old draft box together with another scope the client left out', async () => {
    const notAsked = await consent('owner', orgId, 'approve', undefined, { scope: `ludy.read ${ENGAGE}`, writes: [ADS] });
    expect(notAsked.consentStatus).toBe(422);
    const asMember = await consent('owner', orgId, 'approve', 'member', { scope: ALL_WRITES, writes: [ENGAGE] });
    expect(asMember.consentStatus).toBe(422);
    // The old one-box form means the Social draft scope: refused when the client did not ask for it, and the same scope as `writes: [DRAFT]` (one scope, not two) when it did.
    const oldBoxNotAsked = await consent('owner', orgId, 'approve', undefined, { scope: `ludy.read ${ENGAGE}`, draft: true, writes: [ENGAGE] });
    expect(oldBoxNotAsked.consentStatus).toBe(422);
    const oldBoxAndWrites = await consent('owner', orgId, 'approve', undefined, { scope: `ludy.read ${DRAFT}`, draft: true, writes: [DRAFT] });
    expect(oldBoxAndWrites.consentStatus).toBe(200);
    expect(claimsOf(await tokenOf(oldBoxAndWrites)).scope.split(' ').sort()).toEqual(['ludy.read', DRAFT]);
    const noRead = await consent('owner', orgId, 'approve', undefined, { scope: ENGAGE, writes: [ENGAGE] });
    expect(noRead.details.body).toMatchObject({ scopes: ['ludy.read'] });
    expect(noRead.consentStatus).toBe(422);
    for (const c of [notAsked, asMember, oldBoxNotAsked, noRead]) {
      expect((await admin((client) => client.query(`SELECT count(*)::int AS n FROM ludy_kernel.agent_grant WHERE client_id = $1`, [c.clientId]))).rows[0].n).toBe(0);
    }
  });

  it('answers a draft over the drafts budget with the seconds to wait, before the command runs', async () => {
    const access = await tokenOf(await draftGrant({ draft: true }));
    const connectionId = randomUUID();
    await admin((client) => client.query(`INSERT INTO ludy_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) SELECT $1, $2, 'sandbox', 'acct-mcp-budget', 'Kênh hạn mức', user_id FROM ludy_kernel.tenant_member WHERE org_id = $1 AND role = 'owner' LIMIT 1`, [orgId, connectionId]));
    const call = () => mcpModern(access, 'tools/call', { name: 'ludy_social_draft_create', arguments: { body: 'Bản nháp', channels: [{ connectionId }] } }, 'ludy_social_draft_create');
    const before = Number((await admin((client) => client.query(`SELECT count(*) AS n FROM ludy_social.post WHERE org_id = $1`, [orgId]))).rows[0].n);
    const answers: string[] = [];
    for (let i = 0; i < 8; i += 1) answers.push((await call()).body?.error?.message ?? 'ok');
    // A person's own budget is six a minute for a member of an org (the draft of the first test of this group is one of them, unless a minute has passed); the rest wait.
    const made = answers.filter((a) => a === 'ok').length;
    expect(made).toBeGreaterThanOrEqual(5);
    expect(made).toBeLessThanOrEqual(6);
    expect(answers.filter((a) => /^Too many drafts just now; try again in \d+ seconds$/.test(a)).length).toBe(8 - made);
    const after = Number((await admin((client) => client.query(`SELECT count(*) AS n FROM ludy_social.post WHERE org_id = $1`, [orgId]))).rows[0].n);
    expect(after - before).toBe(made);
  });
});

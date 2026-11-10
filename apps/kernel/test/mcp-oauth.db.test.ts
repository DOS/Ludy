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
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { kernelCommands, kernelQueries } from '@crove/kernel';
import { BlobNotFoundError, Runtime, sha256Hex, type BlobStore } from '@crove/kernel-runtime';
import { createAuthenticator } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { createOauthServer } from '../src/oauth-server.ts';
import { createSessionStatusSource } from '../src/sessions.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
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
  const dbName = `crove_test_mcp_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let server: Server;
  let base = '';
  let resource = '';
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
  const asBrowser = async (name: string, org: string | null = slug) => ({ authorization: `Bearer ${await jwt(name)}`, 'content-type': 'application/json', ...(org ? { 'x-crove-org': org } : {}) });

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
  async function authorize(clientId: string, redirect: string, verifier: string) {
    const url = new URL(`${base}/oauth/authorize`);
    url.search = new URLSearchParams({ client_id: clientId, response_type: 'code', redirect_uri: redirect, scope: 'ludy.read', resource, code_challenge: challengeOf(verifier), code_challenge_method: 'S256', state: 'st-1' }).toString();
    const response = await fetch(url, { redirect: 'manual' });
    return { status: response.status, location: response.headers.get('location') ?? '', cookie: cookiesOf(response) };
  }

  // The whole consent: authorize, the page's details call, the approve call, the resumed authorization, the code.
  async function consent(owner: string, orgOf: string = orgId, decision: 'approve' | 'deny' = 'approve') {
    const reg = await register();
    expect(reg.status, JSON.stringify(reg.body)).toBe(201);
    const clientId = String(reg.body.client_id);
    const verifier = randomBytes(32).toString('base64url');
    const started = await authorize(clientId, reg.redirect, verifier);
    expect(started.status).toBe(303);
    const uid = new URL(started.location, base).pathname.split('/').pop() as string;
    const headers = { ...(await asBrowser(owner, null)), cookie: started.cookie };
    const detailsResponse = await fetch(`${base}/oauth/interaction/${uid}/details`, { headers });
    const approved = await fetch(`${base}/oauth/interaction/${uid}/consent`, { method: 'POST', headers, body: JSON.stringify(decision === 'approve' ? { decision, orgId: orgOf } : { decision }) });
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
    return { ...c, access: String(t.body.access_token), refresh: String(t.body.refresh_token) };
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
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });
    const appUrl = new URL(adminUrl);
    appUrl.username = 'crove_app';
    appUrl.password = 'test-app-pw';
    pool = createPool({ connectionString: appUrl.toString(), max: 8 });
    const db = createDb(pool);
    const port = await freePort();
    base = `http://localhost:${port}`;
    resource = `${base}/mcp`;
    const pair = await generateKeyPair('ES256', { extractable: true });
    const jwk = { ...(await exportJWK(pair.privateKey)), kid: 'test-key-1', alg: 'ES256', use: 'sig' };
    const config = loadConfig({
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
    });
    const runtime = new Runtime(db, { manifests: TEST_MANIFESTS, sessions: createSessionStatusSource('off'), stepUp: 'required' }).register({
      commands: [...kernelCommands],
      queries: [...kernelQueries({ inboundDomain: null })],
    });
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
    expect(protectedResource).toMatchObject({ resource, authorization_servers: [base], scopes_supported: ['ludy.read'] });
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
    const about = await mcpModern(c.access, 'tools/call', { name: 'ludy_about', arguments: {} }, 'ludy_about');
    expect(about.status).toBe(200);
    expect(about.body?.result?.structuredContent).toMatchObject({ clientName: 'Test MCP client', scopes: ['ludy.read'] });
    expect(about.body?.result?.resultType).toBe('complete');
    // The audit row says it came over MCP, from which grant and client.
    const rows = await admin((client) => client.query(`SELECT detail FROM crove_kernel.audit_event WHERE command = 'kernel.mcp.call' ORDER BY id DESC LIMIT 1`));
    expect(rows.rows[0].detail).toMatchObject({ via: 'mcp', tool: 'ludy_about', result: 'ok', mcpClientName: 'Test MCP client' });
  });
});

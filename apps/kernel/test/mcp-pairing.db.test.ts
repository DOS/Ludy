// SPDX-License-Identifier: AGPL-3.0-only
// The pairing code of the MCP endpoint end to end, on a real database and a real HTTP server (#4591; ADR-0051 decision 2, the fallback for an AI app without OAuth): an owner makes a code in Settings
// (the oRPC call the screen makes), a fake MCP client that cannot do OAuth trades it at /oauth/pairing/redeem for a token and reads over /mcp under the grant's scope, and sees exactly what an
// OAuth-connected client sees. A reused, expired, wrong or malformed code and a revoked grant are refused with one generic error. The security rules (hash only, single use, standing) are pinned in
// test/invariant/mcp-pairing.db.test.ts.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
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

suite('the pairing code of the MCP endpoint (#4591)', () => {
  const dbName = `crove_test_mcp_pairing_http_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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

  // A fresh app over the same runtime and database: its own rate limits, so one test's attempts never count against another's.
  const freshApp = async () => {
    const config = loadConfig(bootEnv);
    const oauth = await createOauthServer(config, (fn) => sharedRuntime.orgless(fn));
    return createHttpApp({ config, oauth, runtime: sharedRuntime, store: new MemoryStore(), authenticate: createAuthenticator(config, sharedDb), pool, aiEnabled: false });
  };
  type App = Awaited<ReturnType<typeof freshApp>>;
  const redeem = (app: App, body: unknown) =>
    app.request(`${base}/oauth/pairing/redeem`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  const mcpCall = async (app: App, access: string, method: string, params: Record<string, unknown> = {}, name?: string) => {
    const response = await app.request(`${base}/mcp`, {
      method: 'POST',
      headers: modernHeaders(access, method, name),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } } }),
    });
    return { status: response.status, body: (await response.json().catch(() => null)) as Record<string, any> | null };
  };
  // The Settings action: the call the screen makes, as the signed-in person.
  const issueCode = async (who = 'owner', label = 'Home-made agent') => rpc('mcp/pairing/issue', await asBrowser(who), { label });
  const pair = async (app: App, who = 'owner', label = 'Home-made agent') => {
    const made = await issueCode(who, label);
    expect(made.status, JSON.stringify(made.body)).toBe(200);
    const answer = await redeem(app, { code: made.body.code });
    expect(answer.status).toBe(200);
    const token = (await answer.json()) as { access_token: string; token_type: string; expires_in: number; scope: string };
    return { made, token };
  };
  const GENERIC = { error: 'invalid_grant', error_description: 'The pairing code is not valid' };
  const grantsOf = async (name = 'owner') => (await rpc('mcp/grant/list', await asBrowser(name), {})).body as unknown as Array<{ id: string; clientId: string; clientName: string; clientHost: string; scopes: string[]; kind: string; revokedAt: string | null }>;

  it('has an owner make a code in Settings, shown once as XXXX-XXXX-XXXX with its end, and keeps nothing of it in clear', async () => {
    const made = await issueCode('owner', 'Sales agent');
    expect(made.status, JSON.stringify(made.body)).toBe(200);
    expect(String(made.body.code)).toMatch(/^[A-HJKMNP-TV-Z2-9]{4}-[A-HJKMNP-TV-Z2-9]{4}-[A-HJKMNP-TV-Z2-9]{4}$/);
    const ends = new Date(String(made.body.expiresAt)).getTime() - Date.now();
    expect(ends).toBeGreaterThan(9 * 60_000);
    expect(ends).toBeLessThanOrEqual(10 * 60_000);
    const raw = String(made.body.code).replaceAll('-', '');
    const dump = await admin(async (client) => (await client.query<{ blob: string }>(`SELECT (SELECT coalesce(string_agg(payload::text || encode(key_hash, 'hex'), ' '), '') FROM ludy_kernel.oauth_record) || (SELECT coalesce(string_agg(detail::text, ' '), '') FROM ludy_kernel.audit_event) AS blob`)).rows[0]?.blob ?? '');
    expect(dump).not.toContain(raw);
    expect(dump).not.toContain(String(made.body.code));
  });

  it('refuses a code to anyone who is not an owner or admin of the org, and to a request with no sign-in', async () => {
    const member = 'plain-member';
    await jwt(member);
    const email = accounts.get(member)?.email;
    const invited = await rpc('org/invite', await asBrowser('owner'), { email, role: 'member' });
    expect(invited.status).toBe(200);
    expect((await rpc('invites/accept', await asBrowser(member, null), { token: String(invited.body.acceptPath).split('#')[1] })).status).toBe(200);
    expect((await issueCode(member)).status).toBe(403);
    const anonymous = await fetch(`${base}/api/rpc/mcp/pairing/issue`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-crove-org': slug }, body: JSON.stringify({ json: { label: 'x' } }) });
    expect(anonymous.status).toBe(401);
  });

  it('lets a client that cannot do OAuth trade the code for a token and read over /mcp under the grant\'s scope, with the same audit as an OAuth grant', async () => {
    const app = await freshApp();
    const { token } = await pair(app, 'owner', 'Fake MCP client');
    expect(token.token_type).toBe('Bearer');
    expect(token.scope).toBe('ludy.read');
    expect(token.access_token).toMatch(/^lpt_[A-Za-z0-9_-]{43}$/);
    expect(token.expires_in).toBeGreaterThan(29 * 86_400);
    // A static-bearer MCP client (the SDK's own, with the header and no OAuth provider) lists the tools and calls a read tool.
    const transport = new StreamableHTTPClientTransport(new URL(resource), { requestInit: { headers: { authorization: `Bearer ${token.access_token}` } } });
    const client = new McpClient({ name: 'fake-no-oauth-client', version: '1.0.0' });
    await client.connect(transport);
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((t) => t.name)).toContain('ludy_about');
      const about = await client.callTool({ name: 'ludy_about', arguments: {} });
      expect(about.structuredContent).toMatchObject({ clientName: 'Fake MCP client', scopes: ['ludy.read'] });
    } finally {
      await client.close();
    }
    // The call audit row is the one an OAuth grant writes: the system's, naming the grant, the client and the tool.
    const rows = await admin((c) => c.query(`SELECT detail FROM ludy_kernel.audit_event WHERE command = 'kernel.mcp.call' AND detail ->> 'mcpClientName' = 'Fake MCP client' ORDER BY id DESC LIMIT 1`));
    expect(rows.rows[0]?.detail).toMatchObject({ mcpCall: true, tool: 'ludy_about', result: 'ok', mcpClientName: 'Fake MCP client' });
    // The grant is listed in Settings as a company connection of the read scope, and is disconnected the same way as any other.
    const mine = (await grantsOf()).find((g) => g.clientName === 'Fake MCP client');
    expect(mine).toMatchObject({ kind: 'company', scopes: ['ludy.read'], revokedAt: null });
    expect(mine?.clientId.startsWith('pairing:')).toBe(true);
  });

  it('shows the connected coworker exactly what an OAuth-connected client sees: the same tools, the same answers, nothing new', async () => {
    const app = await freshApp();
    const { token } = await pair(app, 'owner', 'Paired');
    const oauth = await connect();
    const toolsOf = async (access: string) => {
      const listed = await mcpCall(app, access, 'tools/list');
      expect(listed.status).toBe(200);
      return ((listed.body?.result?.tools ?? []) as Array<{ name: string; inputSchema: unknown; annotations: unknown }>).map((t) => JSON.stringify([t.name, t.inputSchema, t.annotations])).sort();
    };
    const viaOauth = await toolsOf(oauth.access);
    expect(viaOauth.length).toBeGreaterThan(0);
    expect(await toolsOf(token.access_token)).toEqual(viaOauth);
    // A read tool answers the same rows (the org's parties), and the write tools stay unlisted for the read scope.
    const parties = (access: string) => mcpCall(app, access, 'tools/call', { name: 'ludy_parties_list', arguments: {} }, 'ludy_parties_list');
    const a = await parties(oauth.access);
    const b = await parties(token.access_token);
    expect(b.status).toBe(200);
    expect(b.body?.result?.structuredContent).toEqual(a.body?.result?.structuredContent);
    const names = (viaOauth as string[]).map((t) => (JSON.parse(t) as [string])[0]);
    for (const write of ['ludy_social_draft_create']) expect(names).not.toContain(write);
  });

  it('answers a reused, a wrong, an expired and a malformed code with the same generic refusal, and a revoked grant with 401 at once', async () => {
    const app = await freshApp();
    const made = await issueCode();
    const code = String(made.body.code);
    const first = await redeem(app, { code });
    expect(first.status).toBe(200);
    const token = ((await first.json()) as { access_token: string }).access_token;
    // Reuse, with the dashes dropped and in lower case too: the same code is the same code.
    const reused = await redeem(app, { code: code.replaceAll('-', '').toLowerCase() });
    expect(reused.status).toBe(400);
    expect(await reused.json()).toEqual(GENERIC);
    // A wrong code of the right shape, and one that cannot be a code.
    const wrong = await redeem(app, { code: 'AAAA-AAAA-AAAA' });
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toEqual(GENERIC);
    const malformedApp = await freshApp();
    for (const bad of [{ code: 'short' }, { code: '' }, {}, { code: 12345 }, { code: 'O0O0-I1I1-LLLL' }, '[]', 'not json']) {
      const refused = await redeem(malformedApp, bad);
      expect([refused.status, await refused.json()]).toEqual([400, GENERIC]);
    }
    // Expired: the same answer, and the grant it would have made does not exist.
    const old = await issueCode();
    await admin((c) => c.query(`UPDATE ludy_kernel.oauth_record SET expires_at = now() - interval '1 second' WHERE model = 'PairingCode' AND consumed_at IS NULL AND payload ->> 'label' = 'Home-made agent' AND expires_at > now()`));
    const expired = await redeem(app, { code: old.body.code });
    expect([expired.status, await expired.json()]).toEqual([400, GENERIC]);
    // The token works until the grant is disconnected in Settings, and then is refused at the very next call.
    expect((await mcpCall(app, token, 'tools/call', { name: 'ludy_about', arguments: {} }, 'ludy_about')).status).toBe(200);
    const mine = (await grantsOf()).filter((g) => g.clientId.startsWith('pairing:') && !g.revokedAt);
    expect(mine.length).toBeGreaterThan(0);
    for (const g of mine) expect((await rpc('mcp/grant/revoke', await asBrowser('owner'), { grantId: g.id })).status).toBe(200);
    expect((await mcpCall(app, token, 'tools/call', { name: 'ludy_about', arguments: {} }, 'ludy_about')).status).toBe(401);
    // The code of a revoked grant is not a way back in: it was used.
    expect((await redeem(app, { code })).status).toBe(400);
  });

  it('does not let a pairing token pass as a browser session, nor a changed or truncated one pass at /mcp', async () => {
    const app = await freshApp();
    const { token } = await pair(app);
    const onApi = await fetch(`${base}/api/rpc/me/get`, { method: 'POST', headers: { authorization: `Bearer ${token.access_token}`, 'content-type': 'application/json' }, body: '{}' });
    expect(onApi.status).toBe(401);
    for (const bad of [`${token.access_token.slice(0, -1)}${token.access_token.endsWith('A') ? 'B' : 'A'}`, token.access_token.slice(0, 20), `${token.access_token}x`, 'lpt_', `lpt_${'A'.repeat(43)}`]) {
      expect((await mcpCall(app, bad, 'tools/call', { name: 'ludy_about', arguments: {} }, 'ludy_about')).status, bad).toBe(401);
    }
  });

  it('closes a pairing grant when its person loses the owner or admin role, as an OAuth grant closes', async () => {
    const app = await freshApp();
    const second = 'pairing-admin';
    await jwt(second);
    const email = accounts.get(second)?.email;
    const invited = await rpc('org/invite', await asBrowser('owner'), { email, role: 'admin' });
    expect(invited.status).toBe(200);
    expect((await rpc('invites/accept', await asBrowser(second, null), { token: String(invited.body.acceptPath).split('#')[1] })).status).toBe(200);
    const { token } = await pair(app, second, 'By an admin');
    expect((await mcpCall(app, token.access_token, 'tools/call', { name: 'ludy_about', arguments: {} }, 'ludy_about')).status).toBe(200);
    await admin((client) => client.query(`UPDATE ludy_kernel.tenant_member SET role = 'member' WHERE org_id = $1 AND user_id = (SELECT id FROM ludy_kernel.user_account WHERE email = $2)`, [orgId, email]));
    expect((await mcpCall(app, token.access_token, 'tools/call', { name: 'ludy_about', arguments: {} }, 'ludy_about')).status).toBe(401);
  });

  it('rate limits the redeem per address and answers 429 with Retry-After, and never says whether a code exists', async () => {
    const app = await freshApp();
    const seen = new Set<number>();
    let limited: Response | null = null;
    for (let attempt = 0; attempt < 14; attempt++) {
      const response = await redeem(app, { code: 'BBBB-BBBB-BBBB' });
      seen.add(response.status);
      if (response.status === 429) {
        limited = response;
        break;
      }
      expect(await response.json()).toEqual(GENERIC);
    }
    expect(limited, 'the limit is reached within a few attempts').not.toBeNull();
    expect(seen).toEqual(new Set([400, 429]));
    expect(Number(limited?.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect(await limited?.json()).toMatchObject({ error: 'too_many_requests' });
  });

  it('never caches an answer and sets the edge\'s security headers on the token and on the refusal', async () => {
    const app = await freshApp();
    const made = await issueCode();
    for (const code of [String(made.body.code), 'CCCC-CCCC-CCCC']) {
      const response = await redeem(app, { code });
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(response.headers.get('x-request-id')).toBeTruthy();
      expect(response.headers.get('content-type')).toContain('application/json');
    }
  });

  it('answers a body that is too large with 413 and does not read it', async () => {
    const app = await freshApp();
    const response = await redeem(app, JSON.stringify({ code: 'A'.repeat(4096) }));
    expect(response.status).toBe(413);
  });
});

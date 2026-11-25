// SPDX-License-Identifier: AGPL-3.0-only
// Multi-replica DB rate-limit tests for /oauth/* and /mcp (#3978).

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
const SECRET = `test-only-mcp-rl-${'0'.repeat(24)}`;
const ISSUER = 'https://auth.example.test/auth/v1';
const SHARED_PUBLIC_URL = 'http://localhost:39998';

class MemoryStore implements BlobStore {
  private readonly blobs = new Map<string, Uint8Array>();
  async put(key: string, bytes: Uint8Array): Promise<string> {
    this.blobs.set(key, new Uint8Array(bytes));
    return `content:${sha256Hex(bytes)}`;
  }
  async get(key: string): Promise<Uint8Array> {
    const found = this.blobs.get(key);
    if (!found) throw new BlobNotFoundError(key);
    return found;
  }
  async getRange(key: string, start: number, end: number): Promise<Uint8Array> {
    return (await this.get(key)).subarray(start, end + 1);
  }
  async delete(key: string): Promise<void> {
    this.blobs.delete(key);
  }
}

const challengeOf = (verifier: string): string => createHash('sha256').update(verifier, 'ascii').digest('base64url');
const cookiesOf = (response: Response): string => response.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => resolve(port));
    });
  });

describe.skipIf(!ADMIN)('multi-replica DB rate limits for /oauth/* and /mcp (#3978)', () => {
  const dbName = `ludy_test_mcp_rl_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let sharedDb: ReturnType<typeof createDb>;
  let sharedRuntime: Runtime;
  let bootEnv: Record<string, string> = {};
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

  async function spawnReplica(env: Record<string, string> = {}) {
    const port = await freePort();
    const url = `http://localhost:${port}`;
    const config = loadConfig({ ...bootEnv, PUBLIC_URL: SHARED_PUBLIC_URL, ...env });
    const oauth = await createOauthServer(config, (fn) => sharedRuntime.orgless(fn));
    const app = createHttpApp({
      config,
      oauth,
      runtime: sharedRuntime,
      store: new MemoryStore(),
      authenticate: createAuthenticator(config, sharedDb),
      pool,
      aiEnabled: false,
    });
    const server = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }) as unknown as Server;
    await new Promise((resolve) => setTimeout(resolve, 100));
    return {
      url,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }

  async function ownerToken(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({
      role: 'authenticated',
      email: 'owner@mcp-rl.test',
      session_id: randomUUID(),
      is_anonymous: false,
      aal: 'aal2',
      amr: [{ method: 'totp', timestamp: now }],
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(randomUUID())
      .setIssuer(ISSUER)
      .setAudience('authenticated')
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(new TextEncoder().encode(SECRET));
  }

  async function connectGrant(baseUrl: string, token: string): Promise<{ access: string; grantId: string }> {
    const reg = await fetch(`${baseUrl}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.200' },
      body: JSON.stringify({
        client_name: 'Replica Grant Client',
        redirect_uris: ['http://127.0.0.1:39999/cb'],
        application_type: 'native',
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      }),
    });
    expect(reg.status).toBe(201);
    const clientId = String(((await reg.json()) as Record<string, unknown>).client_id);
    const verifier = randomBytes(32).toString('base64url');
    const authUrl = new URL(`${baseUrl}/oauth/authorize`);
    authUrl.search = new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: 'http://127.0.0.1:39999/cb',
      scope: 'ludy.read',
      resource: `${SHARED_PUBLIC_URL}/mcp`,
      code_challenge: challengeOf(verifier),
      code_challenge_method: 'S256',
      state: 'st-rl',
    }).toString();
    const started = await fetch(authUrl, { redirect: 'manual', headers: { 'x-forwarded-for': '198.51.100.200' } });
    expect(started.status).toBe(303);
    const cookie = cookiesOf(started);
    const uid = new URL(started.headers.get('location') ?? '', baseUrl).pathname.split('/').pop() as string;
    const approved = await fetch(`${baseUrl}/oauth/interaction/${uid}/consent`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', cookie },
      body: JSON.stringify({ decision: 'approve', orgId }),
    });
    expect(approved.status).toBe(200);
    const answer = (await approved.json()) as { redirectTo: string };
    const resumedTarget = new URL(answer.redirectTo, baseUrl);
    const resumed = await fetch(`${baseUrl}${resumedTarget.pathname}${resumedTarget.search}`, {
      redirect: 'manual',
      headers: { cookie: `${cookie}; ${cookiesOf(approved)}`, 'x-forwarded-for': '198.51.100.200' },
    });
    const code = new URL(resumed.headers.get('location') ?? '').searchParams.get('code') ?? '';
    const tokenRes = await fetch(`${baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': '198.51.100.200' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: 'http://127.0.0.1:39999/cb',
        code_verifier: verifier,
        client_id: clientId,
        resource: `${SHARED_PUBLIC_URL}/mcp`,
      }).toString(),
    });
    expect(tokenRes.status).toBe(200);
    const tokenBody = (await tokenRes.json()) as { access_token: string };
    const grantRow = await admin((c) => c.query<{ id: string }>(`SELECT id FROM ludy_kernel.agent_grant WHERE client_id = $1`, [clientId]));
    return { access: tokenBody.access_token, grantId: grantRow.rows[0]!.id };
  }

  let setupToken = '';

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
    pool = createPool({ connectionString: appUrl.toString(), max: 10 });
    sharedDb = createDb(pool);
    sharedRuntime = new Runtime(sharedDb, {
      manifests: TEST_MANIFESTS,
      sessions: createSessionStatusSource('off'),
      stepUp: 'required',
    }).register({
      commands: [...kernelCommands, ...socialCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries, ...crmQueries, ...projectsQueries, ...socialQueries],
    });

    const pair = await generateKeyPair('ES256', { extractable: true });
    const jwk = { ...(await exportJWK(pair.privateKey)), kid: 'test-key-rl', alg: 'ES256', use: 'sig' };
    bootEnv = {
      DATABASE_URL: appUrl.toString(),
      AUTH_JWT_SECRET: SECRET,
      AUTH_ISSUER: ISSUER,
      AUTH_SESSION_CHECK: 'off',
      MIGRATIONS_DIR: MIGRATIONS,
      WEB_DIST: '/nonexistent',
      PUBLIC_URL: 'http://localhost:39998',
      OAUTH_SERVER: 'on',
      OAUTH_JWKS: JSON.stringify({ keys: [jwk] }),
      OAUTH_COOKIE_KEYS: 'test-cookie-key-0123456789-abcdefghij-0123',
      TRUSTED_PROXY_HOPS: '1',
      MCP_GRANT_PER_MINUTE: '3',
      MCP_GRANT_CONCURRENCY: '4',
      OAUTH_REGISTER_PER_MINUTE: '2',
      OAUTH_REGISTER_GLOBAL_PER_MINUTE: '10',
      MCP_ALLOWED_ORIGINS: 'https://allowed.example.com',
    };

    const seedReplica = await spawnReplica();
    try {
      setupToken = await ownerToken();
      const created = await fetch(`${seedReplica.url}/api/rpc/org/create`, {
        method: 'POST',
        headers: { authorization: `Bearer ${setupToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ json: { name: 'Replica Rate Limit Org', idempotencyKey: randomUUID() } }),
      });
      expect(created.status).toBe(200);
      const body = (await created.json()) as { json?: { slug: string; orgId: string }; slug?: string; orgId?: string };
      const data = body.json ?? body;
      slug = String(data.slug);
      orgId = String(data.orgId);
      expect(slug.length).toBeGreaterThan(0);
    } finally {
      await seedReplica.close();
    }
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('shares /oauth/register per-address and global limits across two independent server instances', async () => {
    await admin((c) => c.query('DELETE FROM ludy_kernel.mcp_rate_limit'));
    const replicaA = await spawnReplica({ OAUTH_REGISTER_PER_MINUTE: '2', OAUTH_REGISTER_GLOBAL_PER_MINUTE: '3' });
    const replicaB = await spawnReplica({ OAUTH_REGISTER_PER_MINUTE: '2', OAUTH_REGISTER_GLOBAL_PER_MINUTE: '3' });
    const registerOn = (baseUrl: string, ip: string) =>
      fetch(`${baseUrl}/oauth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
        body: JSON.stringify({
          client_name: 'x',
          redirect_uris: ['http://127.0.0.1:39999/cb'],
          application_type: 'native',
          token_endpoint_auth_method: 'none',
        }),
      });
    try {
      expect((await registerOn(replicaA.url, '198.51.100.1')).status).toBe(201);
      expect((await registerOn(replicaB.url, '198.51.100.1')).status).toBe(201);
      const perAddrBlocked = await registerOn(replicaA.url, '198.51.100.1');
      expect(perAddrBlocked.status).toBe(429);
      expect(Number(perAddrBlocked.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
      expect(perAddrBlocked.headers.get('x-content-type-options')).toBe('nosniff');

      expect((await registerOn(replicaB.url, '198.51.100.2')).status).toBe(201);
      const globalBlocked = await registerOn(replicaA.url, '198.51.100.3');
      expect(globalBlocked.status).toBe(429);
      expect(Number(globalBlocked.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    } finally {
      await Promise.all([replicaA.close(), replicaB.close()]);
    }
  });

  it('shares /oauth/pairing/redeem limits per address across replicas without blocking other callers', async () => {
    await admin((c) => c.query('DELETE FROM ludy_kernel.mcp_rate_limit'));
    const replicaA = await spawnReplica();
    const replicaB = await spawnReplica();
    const redeemOn = (baseUrl: string, ip: string) =>
      fetch(`${baseUrl}/oauth/pairing/redeem`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
        body: JSON.stringify({ code: 'ABCD-EFGH-JKLM' }),
      });
    try {
      for (let i = 0; i < 6; i += 1) expect((await redeemOn(replicaA.url, '203.0.113.10')).status).toBe(400);
      for (let i = 0; i < 4; i += 1) expect((await redeemOn(replicaB.url, '203.0.113.10')).status).toBe(400);
      const limitedA = await redeemOn(replicaA.url, '203.0.113.10');
      expect(limitedA.status).toBe(429);
      expect(Number(limitedA.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
      expect((await redeemOn(replicaB.url, '203.0.113.10')).status).toBe(429);
      expect((await redeemOn(replicaB.url, '203.0.113.11')).status).toBe(400);
    } finally {
      await Promise.all([replicaA.close(), replicaB.close()]);
    }
  });

  it('shares per-grant /mcp limits across replicas, recovers on expiry, and never stores raw keys or grants', async () => {
    await admin((c) => c.query('DELETE FROM ludy_kernel.mcp_rate_limit'));
    const replicaA = await spawnReplica({ MCP_GRANT_PER_MINUTE: '3', OAUTH_REGISTER_PER_MINUTE: '20', OAUTH_REGISTER_GLOBAL_PER_MINUTE: '20' });
    const replicaB = await spawnReplica({ MCP_GRANT_PER_MINUTE: '3', OAUTH_REGISTER_PER_MINUTE: '20', OAUTH_REGISTER_GLOBAL_PER_MINUTE: '20' });
    const callAbout = (baseUrl: string, access: string, ip: string) =>
      fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${access}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': '2026-07-28',
          'mcp-method': 'tools/call',
          'mcp-name': 'ludy_about',
          'x-forwarded-for': ip,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'ludy_about', arguments: {}, _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } },
        }),
      });
    try {
      const { access, grantId } = await connectGrant(replicaA.url, setupToken);

      expect((await callAbout(replicaA.url, access, '198.51.100.51')).status).toBe(200);
      expect((await callAbout(replicaB.url, access, '198.51.100.52')).status).toBe(200);
      expect((await callAbout(replicaA.url, access, '198.51.100.53')).status).toBe(200);

      const refusedB = await callAbout(replicaB.url, access, '198.51.100.54');
      expect(refusedB.status).toBe(429);
      expect(Number(refusedB.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
      expect((await callAbout(replicaA.url, access, '198.51.100.55')).status).toBe(429);

      const rows = await admin((c) => c.query<{ bucket: string; key_hash: string }>(`SELECT bucket, key_hash FROM ludy_kernel.mcp_rate_limit`));
      expect(rows.rows.length).toBeGreaterThan(0);
      const serialized = JSON.stringify(rows.rows);
      expect(rows.rows.every((r) => /^[0-9a-f]{64}$/.test(r.key_hash))).toBe(true);
      expect(serialized).not.toContain(grantId);
      expect(serialized).not.toContain('198.51.100.');

      await admin((c) => c.query(`UPDATE ludy_kernel.mcp_rate_limit SET expires_at = now() - interval '1 second'`));
      expect((await callAbout(replicaB.url, access, '198.51.100.56')).status).toBe(200);
    } finally {
      await Promise.all([replicaA.close(), replicaB.close()]);
    }
  });
});

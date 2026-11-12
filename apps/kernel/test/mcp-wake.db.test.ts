// SPDX-License-Identifier: AGPL-3.0-only
// The wake-up webhook of an MCP grant through the API (ADR-0051 decision 4, issue #3024, step a): the secret is made and sealed by the API and shown once, to the
// person who set the wake-up or rotated its secret, and never by a read; a receiver whose name does not resolve, or resolves to anything but public addresses, is refused
// before the command runs; a deployment without a credential key answers 503; a member who is not an owner or admin reads and changes nothing.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { kernelCommands, kernelQueries } from '@crove/kernel';
import { CredentialVault, parseVaultKey, Runtime, type BlobStore } from '@crove/kernel-runtime';
import { createAuthenticator } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { noCredentialBroker } from '../src/credentials.ts';
import { createHttpApp } from '../src/http.ts';
import { createSessionStatusSource } from '../src/sessions.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const SECRET = 'test-only-jwt-secret-for-mcp-wake-0123456789';
const ISSUER = 'crove-auth';
const suite = ADMIN ? describe : describe.skip;

interface Account {
  subject: string;
  email: string;
  session: string;
  userId: string;
}

// Names the test resolves: one public, one that points inside, one that does not resolve, one with a public and a private answer.
const resolve = async (host: string): Promise<{ address: string }[]> => {
  if (host === 'hooks.example.com') return [{ address: '93.184.216.34' }];
  if (host === 'inside.example.com') return [{ address: '10.0.0.5' }];
  if (host === 'mixed.example.com') return [{ address: '93.184.216.34' }, { address: '169.254.169.254' }];
  return [];
};

suite('the wake-up webhook of an MCP grant through the API (#3024)', () => {
  const dbName = `crove_test_mcp_wake_api_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let apps: Record<'on' | 'noKey', ReturnType<typeof createHttpApp>>;
  const vault = new CredentialVault([parseVaultKey(randomBytes(32).toString('base64'))]);
  const owner: Account = { subject: randomUUID(), email: 'owner@mcp-wake-api.test', session: randomUUID(), userId: '' };
  const viewer: Account = { subject: randomUUID(), email: 'viewer@mcp-wake-api.test', session: randomUUID(), userId: '' };
  let org = { slug: '', orgId: '' };
  let grantId = '';

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  async function tokenFor(who: Account, options: { mfa?: boolean } = {}) {
    const now = Math.floor(Date.now() / 1000);
    const mfa = options.mfa ? { aal: 'aal2', amr: [{ method: 'totp', timestamp: now }] } : {};
    return new SignJWT({ role: 'authenticated', email: who.email, session_id: who.session, aal: 'aal1', is_anonymous: false, ...mfa })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(who.subject)
      .setIssuer(ISSUER)
      .setAudience('authenticated')
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(new TextEncoder().encode(SECRET));
  }

  async function rpc(path: string, token: string, input: unknown, options: { slug?: string | null; app?: keyof typeof apps } = {}) {
    const slug = options.slug === undefined ? org.slug : options.slug;
    const response = await apps[options.app ?? 'on'].request(`/api/rpc/${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(slug ? { 'x-crove-org': slug } : {}) },
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
    const url = new URL(adminUrl);
    url.username = 'crove_app';
    url.password = 'test-app-pw';
    const appUrl = url.toString();
    pool = createPool({ connectionString: appUrl, max: 4 });
    db = createDb(pool);
    const defs = { commands: kernelCommands, queries: kernelQueries({ inboundDomain: null }) };
    const runtime = new Runtime(db, { manifests: TEST_MANIFESTS, sessions: createSessionStatusSource('off'), stepUp: 'required' }).register(defs);
    const config = loadConfig({ DATABASE_URL: appUrl, AUTH_JWT_SECRET: SECRET, AUTH_ISSUER: ISSUER, AUTH_SESSION_CHECK: 'off', MIGRATIONS_DIR: MIGRATIONS, WEB_DIST: '/nonexistent' });
    const store = {} as BlobStore;
    const make = (broker: typeof vault | typeof noCredentialBroker) =>
      createHttpApp({ config, runtime, store, authenticate: createAuthenticator(config, db), pool, aiEnabled: false, channels: { broker, sandbox: false, wakeResolve: resolve } });
    apps = { on: make(vault), noKey: make(noCredentialBroker) };
    for (const who of [owner, viewer]) {
      const me = await rpc('me/get', await tokenFor(who), undefined, { slug: null });
      expect(me.status).toBe(200);
      who.userId = String(me.body?.userId);
    }
    const created = await rpc('org/create', await tokenFor(owner), { name: 'Công ty Báo thức', idempotencyKey: randomUUID() }, { slug: null });
    expect(created.status).toBe(200);
    org = { slug: String(created.body?.slug), orgId: String(created.body?.orgId) };
    const invite = await rpc('org/invite', await tokenFor(owner, { mfa: true }), { email: viewer.email, role: 'viewer' });
    expect(invite.status).toBe(200);
    const accepted = await rpc('invites/accept', await tokenFor(viewer), { token: String(invite.body?.acceptPath).split('#')[1] }, { slug: null });
    expect(accepted.status).toBe(200);
    grantId = randomUUID();
    await admin((c) =>
      c.query(
        `INSERT INTO crove_kernel.agent_grant (org_id, id, user_id, client_id, client_name, client_host, scopes, oauth_grant_id, created_at, expires_at, created_by)
         VALUES ($1, $2, $3, $5, 'Test client', 'client.example.com', ARRAY['ludy.read'], $4, now(), now() + interval '30 days', $3)`,
        [org.orgId, grantId, owner.userId, `oauth-${grantId}`, `client-${grantId}`],
      ),
    );
  });

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  let first = '';

  it('makes the secret on the first set and shows it once, sealed for this grant and nothing else', async () => {
    const token = await tokenFor(owner);
    const made = await rpc('mcp/wake/set', token, { grantId, url: 'https://hooks.example.com/ludy?k=1', schedule: 'daily', minute: 480 });
    expect(made.status).toBe(200);
    expect(made.body).toMatchObject({ grantId, url: 'https://hooks.example.com/ludy?k=1', enabled: true, schedule: 'daily', minute: 480, consecutiveFailures: 0 });
    first = String(made.body.secret);
    expect(first).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    expect(made.body.secretHint).toMatch(/^whk_[0-9a-f]{8}$/);
    const row = await admin((c) => c.query(`SELECT secret_sealed FROM crove_kernel.agent_grant_wake WHERE grant_id = $1`, [grantId]).then((r) => r.rows[0].secret_sealed as { keyId: string; envelope: string }));
    const binding = { orgId: org.orgId, provider: 'mcp-wake', externalAccountId: grantId };
    expect(vault.open({ keyId: row.keyId, envelope: Buffer.from(row.envelope, 'base64') }, binding)).toBe(first);
    expect(() => vault.open({ keyId: row.keyId, envelope: Buffer.from(row.envelope, 'base64') }, { ...binding, externalAccountId: randomUUID() })).toThrow();
  });

  it('shows no secret again: a read, a change to the wake-up and a second set all answer without one, and a change keeps the secret it has', async () => {
    const token = await tokenFor(owner);
    const read = await rpc('mcp/wake/get', token, {});
    expect(read.status).toBe(200);
    expect(read.body).toHaveLength(1);
    expect(JSON.stringify(read.body)).not.toContain(first);
    expect(read.body[0].secret).toBeUndefined();
    const again = await rpc('mcp/wake/set', token, { grantId, url: 'https://hooks.example.com/other', schedule: 'weekly', minute: 60, weekday: 3 });
    expect(again.status).toBe(200);
    expect(again.body.secret).toBeNull();
    expect(again.body).toMatchObject({ url: 'https://hooks.example.com/other', schedule: 'weekly', minute: 60, weekday: 3 });
    const row = await admin((c) => c.query(`SELECT secret_sealed FROM crove_kernel.agent_grant_wake WHERE grant_id = $1`, [grantId]).then((r) => r.rows[0].secret_sealed as { keyId: string; envelope: string }));
    expect(vault.open({ keyId: row.keyId, envelope: Buffer.from(row.envelope, 'base64') }, { orgId: org.orgId, provider: 'mcp-wake', externalAccountId: grantId })).toBe(first);
  });

  it('rotates to a new secret shown once, and keeps the old one for the overlap', async () => {
    const rotated = await rpc('mcp/wake/rotateSecret', await tokenFor(owner), { grantId });
    expect(rotated.status).toBe(200);
    const next = String(rotated.body.secret);
    expect(next).toMatch(/^whsec_/);
    expect(next).not.toBe(first);
    expect(rotated.body.previousUntil).not.toBeNull();
    const row = await admin((c) => c.query(`SELECT secret_sealed, previous_sealed FROM crove_kernel.agent_grant_wake WHERE grant_id = $1`, [grantId]).then((r) => r.rows[0] as { secret_sealed: { keyId: string; envelope: string }; previous_sealed: { keyId: string; envelope: string } }));
    const binding = { orgId: org.orgId, provider: 'mcp-wake', externalAccountId: grantId };
    expect(vault.open({ keyId: row.secret_sealed.keyId, envelope: Buffer.from(row.secret_sealed.envelope, 'base64') }, binding)).toBe(next);
    expect(vault.open({ keyId: row.previous_sealed.keyId, envelope: Buffer.from(row.previous_sealed.envelope, 'base64') }, binding)).toBe(first);
  });

  it('refuses a receiver that does not resolve or resolves inside, before anything is stored, and one that is not an https name', async () => {
    const token = await tokenFor(owner);
    const other = randomUUID();
    await admin((c) =>
      c.query(
        `INSERT INTO crove_kernel.agent_grant (org_id, id, user_id, client_id, client_name, client_host, scopes, oauth_grant_id, created_at, expires_at, created_by)
         VALUES ($1, $2, $3, $5, 'Test client', 'client.example.com', ARRAY['ludy.read'], $4, now(), now() + interval '30 days', $3)`,
        [org.orgId, other, owner.userId, `oauth-${other}`, `client-${other}`],
      ),
    );
    for (const url of ['https://inside.example.com/x', 'https://mixed.example.com/x', 'https://nowhere.example.com/x']) {
      const refused = await rpc('mcp/wake/set', token, { grantId: other, url });
      expect(refused.status, url).toBe(422);
    }
    for (const url of ['http://hooks.example.com/x', 'https://10.0.0.5/x', 'https://hooks.example.com:8443/x']) {
      const refused = await rpc('mcp/wake/set', token, { grantId: other, url });
      expect([400, 422], url).toContain(refused.status);
    }
    expect(await admin((c) => c.query(`SELECT count(*)::int AS n FROM crove_kernel.agent_grant_wake WHERE grant_id = $1`, [other]).then((r) => r.rows[0].n))).toBe(0);
  });

  it('answers 503 without a credential key, and refuses a viewer every procedure', async () => {
    const token = await tokenFor(owner);
    const noKey = await rpc('mcp/wake/set', token, { grantId, url: 'https://hooks.example.com/x' }, { app: 'noKey' });
    expect(noKey.status).toBe(503);
    const noKeyRotate = await rpc('mcp/wake/rotateSecret', token, { grantId }, { app: 'noKey' });
    expect(noKeyRotate.status).toBe(503);
    const viewerToken = await tokenFor(viewer);
    for (const [path, input] of [
      ['mcp/wake/get', {}],
      ['mcp/wake/set', { grantId, url: 'https://hooks.example.com/x' }],
      ['mcp/wake/rotateSecret', { grantId }],
      ['mcp/wake/clear', { grantId }],
    ] as const) {
      const refused = await rpc(path, viewerToken, input);
      expect(refused.status, path).toBe(403);
    }
  });

  it('clears the wake-up, and a second clear is not found', async () => {
    const token = await tokenFor(owner);
    const cleared = await rpc('mcp/wake/clear', token, { grantId });
    expect(cleared.status).toBe(200);
    expect(cleared.body).toEqual({ grantId, cleared: true });
    expect((await rpc('mcp/wake/get', token, { grantId })).body).toEqual([]);
    expect((await rpc('mcp/wake/clear', token, { grantId })).status).toBe(404);
  });
});

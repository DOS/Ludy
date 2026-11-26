// SPDX-License-Identifier: AGPL-3.0-only
// Mobile native push registration, session-bound revocation, token handoff, live access checks,
// and atomic worker content-free dispatch on PostgreSQL 17 (#4883, ADR-0059).
// Set LUDY_TEST_ADMIN_URL (or CROVE_TEST_ADMIN_URL) to a superuser URL; each run creates its own database.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import {
  NATIVE_PUSH_DEVICE_LIMIT,
  NATIVE_PUSH_FAILURE_LIMIT,
  NATIVE_PUSH_MAX_AGE_HOURS,
  createOrg,
  kernelCommands,
  kernelQueries,
  sweepMcpProposalNotices,
  upsertIdentity,
  type NativePushTargetsResult,
} from '@ludy/kernel';
import { BlobNotFoundError, Runtime, sha256Hex, type BlobStore, type CredentialBroker } from '@ludy/kernel-runtime';
import { meetingsCommands, meetingsQueries } from '@ludy/mod-meetings';
import { createAuthenticator } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { QUEUES } from '../src/jobs-schema.ts';
import {
  NATIVE_PUSH_BATCH_LIMIT,
  enqueueNativePushes,
  runNativePushJob,
  type NativePushPayload,
  type NativePushSender,
  type NativePushTarget,
} from '../src/native-push.ts';
import { RateLimiter } from '../src/rate-limit.ts';
import { createSessionStatusSource } from '../src/sessions.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const SECRET = 'test-only-native-push-jwt-secret-0123456789';
const ISSUER = 'ludy-native-push-test';
const EXT_ID = 'c'.repeat(32);
const SYSTEM = { type: 'system' as const, component: 'native-push.test' };
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

interface Person {
  userId: string;
  subject: string;
  email: string;
}

interface OrgFixture {
  orgId: string;
  slug: string;
  owner: Person;
  admin: Person;
  member: Person;
  viewer: Person;
}

suite('native push end-to-end on PostgreSQL 17 (#4883)', () => {
  const dbName = `ludy_test_native_push_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let workerUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let db: Db;
  let workerDb: Db;
  let rt: Runtime;
  let bareRt: Runtime;
  let worker: Runtime;
  let offApp: ReturnType<typeof createHttpApp>;
  let onApp: ReturnType<typeof createHttpApp>;
  const store = new MemoryStore();

  const asUser = (userId: string, sessionId: string = randomUUID(), mfa = false) => ({
    type: 'user' as const,
    userId,
    sessionId,
    aal: (mfa ? 'aal2' : 'aal1') as 'aal1' | 'aal2',
    ...(mfa ? { mfaAt: Math.floor(Date.now() / 1000) } : {}),
  });

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  const rows = async <T extends pg.QueryResultRow>(text: string, params: unknown[] = []) =>
    admin(async (c) => (await c.query<T>(text, params)).rows);

  async function person(name: string): Promise<Person> {
    const subject = randomUUID();
    const email = `${name}-${randomUUID().slice(0, 8)}@native-push.test`;
    const userId = await upsertIdentity(db, { issuer: ISSUER, subject, email, name });
    return { userId, subject, email };
  }

  async function jwt(who: Person, sessionId: string, mfa = false): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const assurance = mfa ? { aal: 'aal2', amr: [{ method: 'totp', timestamp: now }] } : { aal: 'aal1' };
    return new SignJWT({
      role: 'authenticated',
      email: who.email,
      session_id: sessionId,
      is_anonymous: false,
      ...assurance,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(who.subject)
      .setIssuer(ISSUER)
      .setAudience('authenticated')
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(new TextEncoder().encode(SECRET));
  }

  async function rpc(
    app: ReturnType<typeof createHttpApp>,
    path: string,
    token: string,
    input: unknown,
    orgSlug: string | null,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const response = await app.request(`/api/rpc/${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        ...(orgSlug ? { 'x-ludy-org': orgSlug } : {}),
      },
      body: JSON.stringify(input === undefined ? {} : { json: input }),
    });
    const parsed = (await response.json().catch(() => ({}))) as { json?: Record<string, unknown> } & Record<string, unknown>;
    return {
      status: response.status,
      body: (parsed.json ?? parsed) as Record<string, unknown>,
    };
  }

  async function org(): Promise<OrgFixture> {
    const owner = await person('owner');
    const adminUser = await person('admin');
    const member = await person('member');
    const viewer = await person('viewer');
    const { orgId } = await createOrg(rt, asUser(owner.userId), `Org ${randomUUID().slice(0, 6)}`);
    await rows(
      "INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'viewer')",
      [orgId, adminUser.userId, member.userId, viewer.userId],
    );
    const slug = (await rows<{ slug: string }>('SELECT slug FROM ludy_kernel.tenant WHERE org_id = $1', [orgId]))[0]?.slug as string;
    return { orgId, slug, owner, admin: adminUser, member, viewer };
  }

  const registerDevice = (
    orgId: string,
    userId: string,
    sessionId: string,
    opts: { platform?: 'apns' | 'fcm'; token?: string; label?: string } = {},
  ) =>
    rt.execute<{ id: string }>(
      'kernel.native_push.register',
      {
        platform: opts.platform ?? 'apns',
        token: opts.token ?? `apns-device-tok-${randomUUID()}`,
        ...(opts.label !== undefined ? { label: opts.label } : {}),
      },
      { actor: asUser(userId, sessionId), orgId },
    );

  const devicesOf = (orgId: string, userId: string, sessionId: string = randomUUID()) =>
    rt.query<{
      registered: boolean;
      devices: Array<{ id: string; platform: string; label: string | null; createdAt: string; lastUsedAt: string | null; current: boolean }>;
    }>('kernel.native_push.devices', {}, { actor: asUser(userId, sessionId), orgId });

  const targetsOf = (orgId: string, notificationId: string) =>
    worker.query<NativePushTargetsResult | null>('kernel.native_push.targets', { notificationId }, { actor: SYSTEM, orgId });

  function captureSender(
    outcomeOf: (target: NativePushTarget, payload: NativePushPayload) => Promise<'sent' | 'gone' | 'failed'> = async () => 'sent',
  ) {
    const delivered: Array<{ target: NativePushTarget; payload: NativePushPayload }> = [];
    const sender: NativePushSender = {
      id: 'fake-cloud-relay',
      send: async (target, payload) => {
        delivered.push({ target, payload });
        return outcomeOf(target, payload);
      },
    };
    return { sender, delivered };
  }

  async function drainNativePushes(sender: NativePushSender) {
    const queuedJobs: Array<{ orgId: string; notificationId: string }> = [];
    const queued = await workerDb.transaction().execute((trx) =>
      enqueueNativePushes(
        {
          send: async (name, data) => {
            expect(name).toBe(QUEUES.nativePush);
            queuedJobs.push(data as { orgId: string; notificationId: string });
            return randomUUID();
          },
        },
        trx,
        NATIVE_PUSH_BATCH_LIMIT,
      ),
    );
    const results: Array<{ sent: number; gone: number; failed: number }> = [];
    for (const job of queuedJobs) {
      results.push(await runNativePushJob({ runtime: worker, sender, orgId: job.orgId, notificationId: job.notificationId }));
    }
    return { queued, queuedJobs, results };
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
      const u = new URL(adminUrl);
      u.username = username;
      u.password = password;
      return u.toString();
    };
    appUrl = login('ludy_app', 'test-app-pw');
    workerUrl = login('ludy_worker', 'test-worker-pw');
    pool = createPool({ connectionString: appUrl, max: 16 });
    workerPool = createPool({ connectionString: workerUrl, max: 4 });
    db = createDb(pool);
    workerDb = createDb(workerPool);

    const defs = {
      commands: [...kernelCommands, ...meetingsCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...meetingsQueries],
    };
    rt = new Runtime(db, {
      manifests: TEST_MANIFESTS,
      sessions: createSessionStatusSource('off'),
      stepUp: 'required',
    }).register(defs);
    bareRt = new Runtime(db, { manifests: TEST_MANIFESTS }).register(defs);
    worker = new Runtime(workerDb, { manifests: TEST_MANIFESTS }).register(defs);

    const config = loadConfig({
      DATABASE_URL: appUrl,
      AUTH_JWT_SECRET: SECRET,
      AUTH_ISSUER: ISSUER,
      AUTH_SESSION_CHECK: 'off',
      MIGRATIONS_DIR: MIGRATIONS,
      WEB_DIST: '/nonexistent',
      EXTENSION_IDS: EXT_ID,
    });
    const broker = {
      keyId: 'k1-np-test',
      keyIds: ['k1-np-test'],
      derive: (purpose: string) => createHash('sha256').update(`np-secret:${purpose}`).digest(),
      deriveKey: (keyId: string, purpose: string) => createHash('sha256').update(`np-secret:${keyId}:${purpose}`).digest(),
    } as unknown as CredentialBroker;

    offApp = createHttpApp({
      config,
      runtime: rt,
      store,
      broker,
      authenticate: createAuthenticator(config, db),
      pool,
      aiEnabled: false,
      extensionTokenLimit: new RateLimiter({ perMinute: 40 }),
    });
    onApp = createHttpApp({
      config,
      runtime: rt,
      store,
      broker,
      authenticate: createAuthenticator(config, db),
      pool,
      aiEnabled: false,
      extensionTokenLimit: new RateLimiter({ perMinute: 40 }),
      channels: { broker, sandbox: false, nativePush: true },
    });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await workerPool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('enforces self-hosted disabled gate on HTTP RPC, hides device tokens, and rejects extension/sessionless callers', async () => {
    const o = await org();
    const sessionA = randomUUID();
    const memberJwt = await jwt(o.member, sessionA);
    const token = `apns-secret-token-${randomUUID()}`;

    // Unset native push adapter -> status.enabled=false and register fails with 404 NATIVE_PUSH_DISABLED.
    expect(await rpc(offApp, 'notifications/nativePush/status', memberJwt, {}, o.slug)).toEqual({
      status: 200,
      body: { enabled: false, registered: false, devices: [] },
    });
    expect(
      await rpc(offApp, 'notifications/nativePush/register', memberJwt, { platform: 'apns', token, label: 'iPhone Bí Mật' }, o.slug),
    ).toMatchObject({
      status: 404,
      body: { code: 'NATIVE_PUSH_DISABLED' },
    });
    expect(await rows('SELECT 1 FROM ludy_kernel.native_push_device WHERE org_id = $1', [o.orgId])).toHaveLength(0);

    // Enabled adapter -> registration succeeds, status hides raw token, and unregister works even on offApp.
    const registered = await rpc(onApp, 'notifications/nativePush/register', memberJwt, { platform: 'apns', token, label: 'iPhone Bí Mật' }, o.slug);
    expect(registered.status).toBe(200);
    const deviceId = String(registered.body.id);

    const status = await rpc(onApp, 'notifications/nativePush/status', memberJwt, {}, o.slug);
    expect(status.status).toBe(200);
    expect(status.body).toEqual({
      enabled: true,
      registered: true,
      devices: [
        expect.objectContaining({
          id: deviceId,
          platform: 'apns',
          label: 'iPhone Bí Mật',
          current: true,
        }),
      ],
    });
    expect(JSON.stringify(status.body)).not.toContain(token);
    expect(Object.keys((status.body.devices as Array<Record<string, unknown>>)[0] ?? {})).not.toContain('token');

    // Audit rows never leak raw token or pii label.
    const auditRows = await rows<{ command: string; detail: unknown }>(
      "SELECT command, detail FROM ludy_kernel.audit_event WHERE org_id = $1 AND command = 'kernel.native_push.register'",
      [o.orgId],
    );
    expect(auditRows).toHaveLength(1);
    expect(JSON.stringify(auditRows)).not.toContain(token);
    expect(JSON.stringify(auditRows)).not.toContain('iPhone Bí Mật');

    // Runtime checkSession refuses missing sessionId with UNAUTHENTICATED; direct handler refuses with SESSION_REQUIRED.
    await expect(
      rt.execute(
        'kernel.native_push.register',
        { platform: 'fcm', token: `fcm-token-${randomUUID()}` },
        { actor: { type: 'user', userId: o.member.userId, aal: 'aal1' }, orgId: o.orgId },
      ),
    ).rejects.toMatchObject({ status: 401, code: 'UNAUTHENTICATED' });
    await expect(
      bareRt.execute(
        'kernel.native_push.register',
        { platform: 'fcm', token: `fcm-token-${randomUUID()}` },
        { actor: { type: 'user', userId: o.member.userId, aal: 'aal1' }, orgId: o.orgId },
      ),
    ).rejects.toMatchObject({ status: 401, code: 'SESSION_REQUIRED' });

    // Valid extension token issued via /api/extension/authorize + /token cannot access nativePush (403 FORBIDDEN).
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const authRes = await onApp.request('/api/extension/authorize', {
      method: 'POST',
      headers: { authorization: `Bearer ${memberJwt}`, 'content-type': 'application/json', 'x-ludy-org': o.slug },
      body: JSON.stringify({ extensionId: EXT_ID, codeChallenge: challenge, codeChallengeMethod: 'S256', scopes: ['meetings'], deviceName: 'Ext' }),
    });
    expect(authRes.status).toBe(200);
    const code = String(((await authRes.json()) as { code?: string }).code);
    const exRes = await onApp.request('/api/extension/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: `chrome-extension://${EXT_ID}` },
      body: JSON.stringify({ code, codeVerifier: verifier }),
    });
    expect(exRes.status).toBe(200);
    const extToken = String(((await exRes.json()) as { token?: string }).token);
    expect(
      await rpc(onApp, 'notifications/nativePush/register', extToken, { platform: 'fcm', token: `ext-${randomUUID()}-0123456` }, null),
    ).toMatchObject({ status: 403 });

    // When nativePush is unset (offApp), status reports disabled without exposing registered devices, while unregister still cleans up.
    expect(await rpc(offApp, 'notifications/nativePush/status', memberJwt, {}, o.slug)).toEqual({
      status: 200,
      body: { enabled: false, registered: false, devices: [] },
    });
    expect(await rpc(offApp, 'notifications/nativePush/unregister', memberJwt, { current: true }, o.slug)).toEqual({
      status: 200,
      body: { removed: 1 },
    });
  });

  it('supports long tokens, serializes 10-device cap, rotates generation safely, isolates orgs, and reclaims offline-logged-out physical tokens', async () => {
    const orgA = await org();
    const orgB = await org();
    await rows("INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member')", [
      orgB.orgId,
      orgA.member.userId,
      orgA.admin.userId,
    ]);

    const s1 = randomUUID();
    const s2 = randomUUID();
    const token1 = `apns-tok-1-${randomUUID()}`;
    // 3500-char token proves token_sha256 index avoids Postgres 2704-byte B-tree limit.
    const longToken = `apns-${'x'.repeat(3490)}-${randomUUID().slice(0, 4)}`;

    // 1. Re-registering the same (session, platform) with an unchanged token preserves last_used_at, failure_count, and generation;
    // changing the token keeps row id, bumps generation, and ignores outdated generation outcomes.
    const first = await registerDevice(orgA.orgId, orgA.member.userId, s1, { platform: 'apns', token: token1, label: 'Phone Old' });
    await worker.execute(
      'kernel.native_push.record',
      { sent: [{ id: first.id, generation: 1 }], gone: [], failed: [] },
      { actor: SYSTEM, orgId: orgA.orgId },
    );
    const sameTokenRefresh = await registerDevice(orgA.orgId, orgA.member.userId, s1, { platform: 'apns', token: token1, label: 'Phone Same' });
    expect(sameTokenRefresh.id).toBe(first.id);
    expect(
      (await rows<{ generation: number; used: boolean }>('SELECT generation, last_used_at IS NOT NULL AS used FROM ludy_kernel.native_push_device WHERE id = $1', [first.id]))[0],
    ).toEqual({ generation: 1, used: true });

    const replaced = await registerDevice(orgA.orgId, orgA.member.userId, s1, { platform: 'apns', token: longToken, label: 'Phone New' });
    expect(replaced.id).toBe(first.id);
    expect((await rows<{ generation: number }>('SELECT generation FROM ludy_kernel.native_push_device WHERE id = $1', [first.id]))[0]?.generation).toBe(2);

    // Outdated worker record for generation 1 MUST NOT delete or penalize generation 2.
    await worker.execute(
      'kernel.native_push.record',
      {
        sent: [],
        gone: [{ id: first.id, generation: 1 }],
        failed: [{ id: first.id, generation: 1 }],
      },
      { actor: SYSTEM, orgId: orgA.orgId },
    );
    expect(
      (await rows<{ generation: number; failure_count: number }>('SELECT generation, failure_count FROM ludy_kernel.native_push_device WHERE id = $1', [first.id]))[0],
    ).toEqual({ generation: 2, failure_count: 0 });

    // 2. Rotating longToken onto session s2 of the same user moves it out of s1 cleanly.
    const moved = await registerDevice(orgA.orgId, orgA.member.userId, s2, { platform: 'apns', token: longToken, label: 'Phone S2' });
    expect(moved.id).not.toBe(first.id);
    const s1List = await devicesOf(orgA.orgId, orgA.member.userId, s1);
    expect(s1List.registered).toBe(false);
    expect(s1List.devices).toEqual([expect.objectContaining({ id: moved.id, current: false })]);
    const s2List = await devicesOf(orgA.orgId, orgA.member.userId, s2);
    expect(s2List.registered).toBe(true);
    expect(s2List.devices).toEqual([expect.objectContaining({ id: moved.id, current: true })]);

    // 3. Multi-org: same user belongs to orgB without registering in orgB -> orgB devices empty; an outsider is refused 403.
    expect(await devicesOf(orgB.orgId, orgA.member.userId, s2)).toEqual({ registered: false, devices: [] });
    await expect(devicesOf(orgB.orgId, orgA.viewer.userId, randomUUID())).rejects.toMatchObject({ status: 403 });

    // Same user CAN keep the exact same physical token registered in both orgA and orgB.
    await registerDevice(orgB.orgId, orgA.member.userId, s2, { platform: 'apns', token: longToken, label: 'OrgB Device' });
    expect(await rows('SELECT org_id FROM ludy_kernel.native_push_device WHERE user_id = $1 ORDER BY org_id', [orgA.member.userId])).toHaveLength(2);

    // 4. Shared/reassigned phone handoff (Codex P1 #7): another user claiming the exact same physical (apns, longToken) unlinks prior user across orgs!
    const otherUserSession = randomUUID();
    await registerDevice(orgA.orgId, orgA.admin.userId, otherUserSession, { platform: 'apns', token: longToken, label: 'Handed Off Phone' });
    expect(await rows('SELECT 1 FROM ludy_kernel.native_push_device WHERE user_id = $1', [orgA.member.userId])).toHaveLength(0);
    expect(await rows('SELECT 1 FROM ludy_kernel.native_push_device WHERE user_id = $1', [orgA.admin.userId])).toHaveLength(1);

    // 5. Concurrent registrations serialize under the per-member advisory lock and respect NATIVE_PUSH_DEVICE_LIMIT = 10.
    const capResults = await Promise.allSettled(
      Array.from({ length: NATIVE_PUSH_DEVICE_LIMIT + 2 }, (_, i) =>
        registerDevice(orgA.orgId, orgA.member.userId, randomUUID(), { platform: 'fcm', token: `fcm-concurrent-${i}-${randomUUID()}` }),
      ),
    );
    expect(capResults.filter((r) => r.status === 'fulfilled')).toHaveLength(NATIVE_PUSH_DEVICE_LIMIT);
    expect(capResults.filter((r) => r.status === 'rejected')).toHaveLength(2);
    for (const r of capResults) {
      if (r.status === 'rejected') expect(r.reason).toMatchObject({ status: 409, code: 'NATIVE_PUSH_DEVICE_LIMIT' });
    }
  });

  it('automatically removes registrations on session revoke, org-scoped revoke, sign-out everywhere, member removal, and user disable', async () => {
    const orgA = await org();
    const orgB = await org();
    await rows("INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')", [orgB.orgId, orgA.member.userId]);

    const s1 = randomUUID();
    const s2 = randomUUID();
    const s3 = randomUUID();

    await registerDevice(orgA.orgId, orgA.member.userId, s1, { token: `apns-s1-a-${randomUUID()}` });
    await registerDevice(orgB.orgId, orgA.member.userId, s1, { token: `apns-s1-b-${randomUUID()}` });
    await registerDevice(orgA.orgId, orgA.member.userId, s2, { token: `apns-s2-a-${randomUUID()}` });
    await registerDevice(orgB.orgId, orgA.member.userId, s2, { token: `apns-s2-b-${randomUUID()}` });
    await registerDevice(orgB.orgId, orgA.member.userId, s3, { token: `apns-s3-b-${randomUUID()}` });

    // 1. Member revokes single session s1 -> trigger drops s1 across both orgA and orgB, keeping s2 and s3.
    await rt.execute('kernel.session.revoke', { userId: orgA.member.userId, sessionId: s1 }, { actor: asUser(orgA.member.userId, s2), orgId: orgA.orgId });
    expect(
      await rows('SELECT org_id FROM ludy_kernel.native_push_device WHERE user_id = $1 AND session_id = $2', [orgA.member.userId, s1]),
    ).toHaveLength(0);
    expect(
      await rows('SELECT org_id FROM ludy_kernel.native_push_device WHERE user_id = $1 AND session_id = $2 ORDER BY org_id', [orgA.member.userId, s2]),
    ).toHaveLength(2);

    // 2. Owner of orgA revokes member's session s2 in orgA only -> orgA device deleted, orgB s2 device stays!
    await rt.execute('kernel.session.revoke', { userId: orgA.member.userId, sessionId: s2 }, { actor: asUser(orgA.owner.userId), orgId: orgA.orgId });
    expect(
      await rows('SELECT 1 FROM ludy_kernel.native_push_device WHERE org_id = $1 AND user_id = $2 AND session_id = $3', [orgA.orgId, orgA.member.userId, s2]),
    ).toHaveLength(0);
    expect(
      await rows('SELECT 1 FROM ludy_kernel.native_push_device WHERE org_id = $1 AND user_id = $2 AND session_id = $3', [orgB.orgId, orgA.member.userId, s2]),
    ).toHaveLength(1);

    // Next request on orgA with org-revoked session s2 fails SESSION_REVOKED_IN_ORG (401), including HTTP status on offApp (B1).
    const s2Jwt = await jwt(orgA.member, s2);
    expect(await rpc(offApp, 'notifications/nativePush/status', s2Jwt, {}, orgA.slug)).toMatchObject({
      status: 401,
      body: { code: 'SESSION_REVOKED_IN_ORG' },
    });
    expect(await rpc(offApp, 'notifications/nativePush/status', s2Jwt, {}, orgB.slug)).toEqual({
      status: 200,
      body: { enabled: false, registered: false, devices: [] },
    });
    await expect(registerDevice(orgA.orgId, orgA.member.userId, s2, { token: `apns-s2-retry-${randomUUID()}` })).rejects.toMatchObject({
      status: 401,
      code: 'SESSION_REVOKED_IN_ORG',
    });

    // 3. Sign-out everywhere (all: true) revokes remaining active sessions globally -> all devices dropped.
    await rt.execute('kernel.session.revoke', { userId: orgA.member.userId, all: true }, { actor: asUser(orgA.member.userId, s3), orgId: orgB.orgId });
    expect(await rows('SELECT 1 FROM ludy_kernel.native_push_device WHERE user_id = $1', [orgA.member.userId])).toHaveLength(0);

    // 4. Member removal cascades in that org only, and user disable trigger deletes remaining rows.
    await registerDevice(orgA.orgId, orgA.member.userId, randomUUID(), { token: `apns-mem-a-${randomUUID()}` });
    await registerDevice(orgB.orgId, orgA.member.userId, randomUUID(), { token: `apns-mem-b-${randomUUID()}` });

    await rows('DELETE FROM ludy_kernel.tenant_member WHERE org_id = $1 AND user_id = $2', [orgA.orgId, orgA.member.userId]);
    expect(await rows('SELECT 1 FROM ludy_kernel.native_push_device WHERE org_id = $1 AND user_id = $2', [orgA.orgId, orgA.member.userId])).toHaveLength(0);
    expect(await rows('SELECT 1 FROM ludy_kernel.native_push_device WHERE org_id = $1 AND user_id = $2', [orgB.orgId, orgA.member.userId])).toHaveLength(1);

    await rows('UPDATE ludy_kernel.user_account SET disabled_at = now() WHERE id = $1', [orgA.member.userId]);
    expect(await rows('SELECT 1 FROM ludy_kernel.native_push_device WHERE user_id = $1', [orgA.member.userId])).toHaveLength(0);
  });

  it('claims atomically, delivers content-free pushes, suppresses revoked permissions/muted/read/decided/stale/pre-reg, and evicts gone or failing devices', async () => {
    const o = await org();
    const ownerSession = randomUUID();
    const ownerToken = `apns-owner-${randomUUID()}`;
    const ownerDev = await registerDevice(o.orgId, o.owner.userId, ownerSession, { platform: 'apns', token: ownerToken, label: 'Owner iPhone' });
    const adminSession = randomUUID();
    const adminToken = `fcm-admin-${randomUUID()}`;
    const adminDev = await registerDevice(o.orgId, o.admin.userId, adminSession, { platform: 'fcm', token: adminToken, label: 'Admin Android' });
    const memberToken = `fcm-member-${randomUUID()}`;
    await registerDevice(o.orgId, o.member.userId, randomUUID(), { platform: 'fcm', token: memberToken, label: 'Member Android' });

    // Pre-registration unread notice MUST NOT be claimed after device registration.
    const preNoticeId = randomUUID();
    await rows(
      `INSERT INTO ludy_kernel.notification (org_id, id, user_id, kind, dedupe_key, subject_type, subject_id, created_at)
       VALUES ($1, $2, $3, 'kernel.conversation_new', $4, 'kernel.conversation', $5, (SELECT created_at - interval '1 minute' FROM ludy_kernel.native_push_device WHERE id = $6))`,
      [o.orgId, preNoticeId, o.owner.userId, `pre:${preNoticeId}`, randomUUID(), ownerDev.id],
    );
    expect(await targetsOf(o.orgId, preNoticeId)).toBeNull();
    expect((await drainNativePushes(captureSender().sender)).queued).toBe(0);

    // 1. Real conversation intake (kernel.conversation.ingest) with sensitive customer message -> strictly content-free push.
    const connId = randomUUID();
    await rows(
      "INSERT INTO ludy_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, 'sandbox', $3, 'Inbox Test', $4)",
      [o.orgId, connId, `acct-${connId.slice(0, 8)}`, o.owner.userId],
    );
    // Grant desk.agent to o.member so member gets the notice too, mute admin to verify mute suppression, and then revoke member's permission live.
    await rows("INSERT INTO ludy_kernel.role_assignment (org_id, user_id, role_key, granted_by) VALUES ($1, $2, 'desk.agent', $3)", [
      o.orgId,
      o.member.userId,
      o.owner.userId,
    ]);
    await rt.execute('kernel.notification.mute', { kind: 'kernel.conversation_new', muted: true }, { actor: asUser(o.admin.userId), orgId: o.orgId });

    await worker.execute(
      'kernel.conversation.ingest',
      {
        connectionId: connId,
        events: [
          {
            kind: 'direct',
            threadId: 'thread-vip-1',
            messageId: 'msg-vip-1',
            direction: 'in',
            contact: { id: 'cust-1', name: 'Chị Hương VIP' },
            text: 'Chuyển khoản 25.000.000₫, mã đơn VIP-9901 gấp',
            at: new Date(Date.now() - 30_000).toISOString(),
          },
        ],
      },
      { actor: SYSTEM, orgId: o.orgId },
    );
    const convId = (
      await rows<{ id: string }>("SELECT id FROM ludy_kernel.conversation WHERE org_id = $1 AND external_thread_id = 'thread-vip-1'", [o.orgId])
    )[0]?.id as string;

    // Live permission check (Codex P1 #5): remove member's desk.agent role AFTER notice creation -> targetsOf suppresses member's notice!
    const memberConvNoticeId = (
      await rows<{ id: string }>(
        "SELECT id FROM ludy_kernel.notification WHERE org_id = $1 AND user_id = $2 AND kind = 'kernel.conversation_new' AND subject_id = $3",
        [o.orgId, o.member.userId, convId],
      )
    )[0]?.id as string;
    expect(await targetsOf(o.orgId, memberConvNoticeId)).not.toBeNull();
    await rows("DELETE FROM ludy_kernel.role_assignment WHERE org_id = $1 AND user_id = $2 AND role_key = 'desk.agent'", [
      o.orgId,
      o.member.userId,
    ]);
    expect(await targetsOf(o.orgId, memberConvNoticeId)).toBeNull();

    // Atomic rollback check: if boss.send fails inside the worker transaction, native_push_sent rolls back so nothing is dropped!
    await expect(
      workerDb.transaction().execute((trx) =>
        enqueueNativePushes({ send: async () => { throw new Error('pgboss down'); } }, trx, NATIVE_PUSH_BATCH_LIMIT),
      ),
    ).rejects.toThrow('pgboss down');

    const convCap = captureSender();
    const firstDrain = await drainNativePushes(convCap.sender);
    // 2 notices claimed (owner + member), only owner delivers (member permission revoked).
    expect(firstDrain.queued).toBe(2);
    expect(convCap.delivered).toEqual([
      {
        target: { platform: 'apns', token: ownerToken },
        payload: {
          kind: 'kernel.conversation_new',
          title: 'Có 1 hội thoại mới',
          orgSlug: o.slug,
          subjectId: convId,
          path: `/o/${o.slug}/social/inbox?c=${convId}`,
        },
      },
    ]);
    const serializedConv = JSON.stringify(convCap.delivered);
    expect(serializedConv).not.toContain('Hương');
    expect(serializedConv).not.toContain('VIP-9901');
    expect(serializedConv).not.toContain('25.000.000');

    // Second sweep finds nothing left to queue (claimed once in native_push_sent).
    expect((await drainNativePushes(convCap.sender)).queued).toBe(0);
    expect((await rows<{ used: boolean }>('SELECT last_used_at IS NOT NULL AS used FROM ludy_kernel.native_push_device WHERE id = $1', [ownerDev.id]))[0]?.used).toBe(true);

    // 2. Real approval notice (MCP proposal sweep) with valid POLICIES command ('ads.write.enable') + sensitive title -> content-free push.
    const defaultLe = (
      await rows<{ id: string }>('SELECT id FROM ludy_kernel.legal_entity WHERE org_id = $1 AND is_default = true', [o.orgId])
    )[0]?.id as string;
    const grantId = randomUUID();
    await rows(
      `INSERT INTO ludy_kernel.agent_grant (org_id, id, user_id, client_id, client_name, client_host, scopes, oauth_grant_id, created_at, expires_at, created_by, kind, member_id)
       VALUES ($1, $2, $3, $4, 'Dy', 'dy.example.org', ARRAY['ludy.read'], $5, now(), now() + interval '30 days', $3, 'company', NULL)`,
      [o.orgId, grantId, o.admin.userId, `client-${grantId}`, `oauth-${grantId}`],
    );
    const pendingProposalId = (
      await rows<{ id: string }>(
        `INSERT INTO ludy_kernel.proposal (org_id, kind, command, status, title, payload, legal_entity_id, requested_by_grant, mcp_client_name, mcp_client_host, eligible_approvers, authors, tainted)
         VALUES ($1, 'ads.write.enable', 'ads.write.enable', 'pending', 'Chi 88.000.000đ cho Công ty Mật', '{}'::jsonb, $2, $3, 'Dy', 'dy.example.org', $4::uuid[], $5::jsonb, true)
         RETURNING id`,
        [
          o.orgId,
          defaultLe,
          grantId,
          [o.owner.userId, o.admin.userId],
          JSON.stringify([{ type: 'agent', id: grantId, run: grantId }, { type: 'user', id: o.admin.userId }]),
        ],
      )
    )[0]?.id as string;
    await sweepMcpProposalNotices({ runtime: worker, workerDb });

    const approvalCap = captureSender();
    const secondDrain = await drainNativePushes(approvalCap.sender);
    expect(secondDrain.queued).toBe(1);
    expect(approvalCap.delivered).toEqual([
      {
        target: { platform: 'apns', token: ownerToken },
        payload: {
          kind: 'kernel.approval_waiting',
          title: 'Có 1 đề xuất cần duyệt',
          orgSlug: o.slug,
          subjectId: pendingProposalId,
          path: `/o/${o.slug}/inbox/${pendingProposalId}`,
        },
      },
    ]);
    expect(JSON.stringify(approvalCap.delivered)).not.toContain('88.000.000');
    expect(JSON.stringify(approvalCap.delivered)).not.toContain('Công ty Mật');

    // Live approval role / entity revocation check: notice addressed to non-author admin becomes null when demoted to plain member.
    const adminProposalId = (
      await rows<{ id: string }>(
        `INSERT INTO ludy_kernel.proposal (org_id, kind, command, status, title, payload, legal_entity_id, eligible_approvers, authors)
         VALUES ($1, 'ads.write.enable', 'ads.write.enable', 'pending', 'Admin Approval Check', '{}'::jsonb, $2, $3::uuid[], $4::jsonb)
         RETURNING id`,
        [o.orgId, defaultLe, [o.owner.userId, o.admin.userId], JSON.stringify([{ type: 'user', id: o.member.userId }])],
      )
    )[0]?.id as string;
    const adminNoticeId = randomUUID();
    await rows(
      `INSERT INTO ludy_kernel.notification (org_id, id, user_id, kind, dedupe_key, subject_type, subject_id, created_at)
       VALUES ($1, $2, $3, 'kernel.approval_waiting', $4, 'kernel.proposal', $5, (SELECT created_at FROM ludy_kernel.native_push_device WHERE id = $6))`,
      [o.orgId, adminNoticeId, o.admin.userId, `admin-ap:${adminNoticeId}`, adminProposalId, adminDev.id],
    );
    expect(await targetsOf(o.orgId, adminNoticeId)).not.toBeNull();
    await rows("UPDATE ludy_kernel.tenant_member SET role = 'member' WHERE org_id = $1 AND user_id = $2", [o.orgId, o.admin.userId]);
    expect(await targetsOf(o.orgId, adminNoticeId)).toBeNull();

    // Unmapped/retired approval commands and approval notices without subject_id fail closed (B2).
    const unknownCmdProposalId = (
      await rows<{ id: string }>(
        `INSERT INTO ludy_kernel.proposal (org_id, kind, command, status, title, payload, legal_entity_id, eligible_approvers, authors)
         VALUES ($1, 'retired.unknown.command', 'retired.unknown.command', 'pending', 'Retired Command', '{}'::jsonb, $2, $3::uuid[], $4::jsonb)
         RETURNING id`,
        [o.orgId, defaultLe, [o.owner.userId], JSON.stringify([{ type: 'user', id: o.member.userId }])],
      )
    )[0]?.id as string;
    const unknownCmdNoticeId = randomUUID();
    const missingSubjectNoticeId = randomUUID();
    await rows(
      `INSERT INTO ludy_kernel.notification (org_id, id, user_id, kind, dedupe_key, subject_type, subject_id, created_at)
       VALUES
         ($1, $2, $3, 'kernel.approval_waiting', $4, 'kernel.proposal', $5, now()),
         ($1, $6, $3, 'kernel.approval_waiting', $7, NULL, NULL, now())`,
      [o.orgId, unknownCmdNoticeId, o.owner.userId, `unk-cmd:${unknownCmdNoticeId}`, unknownCmdProposalId, missingSubjectNoticeId, `no-subj:${missingSubjectNoticeId}`],
    );
    expect(await targetsOf(o.orgId, unknownCmdNoticeId)).toBeNull();
    expect(await targetsOf(o.orgId, missingSubjectNoticeId)).toBeNull();
    await rt.execute('kernel.notification.read', { ids: [unknownCmdNoticeId, missingSubjectNoticeId] }, { actor: asUser(o.owner.userId), orgId: o.orgId });

    // 3. Suppression checks: unsupported kind, stale >24h notice (with an otherwise identical 23h notice claimed), read notice, decided proposal.
    await rt.execute('kernel.notification.read', { ids: [preNoticeId] }, { actor: asUser(o.owner.userId), orgId: o.orgId });
    await rows("UPDATE ludy_kernel.native_push_device SET created_at = now() - interval '48 hours' WHERE id = $1", [ownerDev.id]);
    const unsupportedId = randomUUID();
    const justInsideId = randomUUID();
    const staleId = randomUUID();
    const readId = randomUUID();
    await rows(
      `INSERT INTO ludy_kernel.notification (org_id, id, user_id, kind, dedupe_key, subject_type, subject_id, created_at)
       VALUES
         ($1, $2, $3, 'kernel.task_assigned', $4, NULL, NULL, now()),
         ($1, $5, $3, 'kernel.conversation_new', $6, 'kernel.conversation', $11, now() - make_interval(hours => $12::int)),
         ($1, $7, $3, 'kernel.conversation_new', $8, 'kernel.conversation', $11, now() - make_interval(hours => $13::int)),
         ($1, $9, $3, 'kernel.conversation_new', $10, NULL, NULL, now())`,
      [
        o.orgId,
        unsupportedId,
        o.owner.userId,
        `unsup:${unsupportedId}`,
        justInsideId,
        `inside:${justInsideId}`,
        staleId,
        `stale:${staleId}`,
        readId,
        `read:${readId}`,
        convId,
        NATIVE_PUSH_MAX_AGE_HOURS - 1,
        NATIVE_PUSH_MAX_AGE_HOURS + 1,
      ],
    );
    await rt.execute('kernel.notification.read', { ids: [readId] }, { actor: asUser(o.owner.userId), orgId: o.orgId });

    // Decided proposal stops target resolution and claiming.
    const rejectedProposalId = (
      await rows<{ id: string }>(
        `INSERT INTO ludy_kernel.proposal (org_id, kind, command, status, title, payload, legal_entity_id, eligible_approvers, authors)
         VALUES ($1, 'ads.write.enable', 'ads.write.enable', 'pending', 'Rejected Notice', '{}'::jsonb, $2, $3::uuid[], $4::jsonb)
         RETURNING id`,
        [o.orgId, defaultLe, [o.owner.userId], JSON.stringify([{ type: 'user', id: o.admin.userId }])],
      )
    )[0]?.id as string;
    const decidedNoticeId = randomUUID();
    await rows(
      `INSERT INTO ludy_kernel.notification (org_id, id, user_id, kind, dedupe_key, subject_type, subject_id, created_at)
       VALUES ($1, $2, $3, 'kernel.approval_waiting', $4, 'kernel.proposal', $5, now())`,
      [o.orgId, decidedNoticeId, o.owner.userId, `decided:${decidedNoticeId}`, rejectedProposalId],
    );
    await rt.execute('kernel.proposal.reject', { id: rejectedProposalId, reason: 'No' }, { actor: asUser(o.owner.userId), orgId: o.orgId });
    expect(await targetsOf(o.orgId, decidedNoticeId)).toBeNull();
    // Claims justInsideId (delivers 1) + adminNoticeId (delivers 0 since demoted); decided/read/stale/unsupported are not claimed.
    const extraCap = captureSender();
    const extraDrain = await drainNativePushes(extraCap.sender);
    expect(extraDrain.queued).toBe(2);
    expect(extraDrain.queuedJobs.map((j) => j.notificationId).sort()).toEqual([adminNoticeId, justInsideId].sort());
    expect(extraDrain.queuedJobs.map((j) => j.notificationId)).not.toContain(staleId);
    expect(extraCap.delivered).toHaveLength(1);
    expect(extraCap.delivered[0]?.payload.subjectId).toBe(convId);

    // 4. Delivery failure threshold: NATIVE_PUSH_FAILURE_LIMIT (10) failures deletes device; 'gone' deletes immediately.
    const failNoticeId = randomUUID();
    await rows(
      `INSERT INTO ludy_kernel.notification (org_id, id, user_id, kind, dedupe_key, subject_type, subject_id, created_at)
       VALUES ($1, $2, $3, 'kernel.conversation_new', $4, 'kernel.conversation', $5, now())`,
      [o.orgId, failNoticeId, o.owner.userId, `fail:${failNoticeId}`, convId],
    );
    const failSender = captureSender(async () => 'failed').sender;
    for (let i = 1; i < NATIVE_PUSH_FAILURE_LIMIT; i++) {
      expect(await runNativePushJob({ runtime: worker, sender: failSender, orgId: o.orgId, notificationId: failNoticeId })).toEqual({
        sent: 0,
        gone: 0,
        failed: 1,
      });
    }
    expect(
      (await rows<{ failure_count: number }>('SELECT failure_count FROM ludy_kernel.native_push_device WHERE id = $1', [ownerDev.id]))[0]?.failure_count,
    ).toBe(NATIVE_PUSH_FAILURE_LIMIT - 1);
    expect(await runNativePushJob({ runtime: worker, sender: failSender, orgId: o.orgId, notificationId: failNoticeId })).toEqual({
      sent: 0,
      gone: 0,
      failed: 1,
    });
    expect(await rows('SELECT 1 FROM ludy_kernel.native_push_device WHERE id = $1', [ownerDev.id])).toHaveLength(0);

    // Register a second device and confirm 'gone' deletes it cleanly on the first response.
    const goneDev = await registerDevice(o.orgId, o.owner.userId, ownerSession, { platform: 'fcm', token: `fcm-gone-${randomUUID()}` });
    const goneNoticeId = randomUUID();
    await rows(
      `INSERT INTO ludy_kernel.notification (org_id, id, user_id, kind, dedupe_key, subject_type, subject_id, created_at)
       VALUES ($1, $2, $3, 'kernel.conversation_new', $4, 'kernel.conversation', $5, (SELECT created_at FROM ludy_kernel.native_push_device WHERE id = $6))`,
      [o.orgId, goneNoticeId, o.owner.userId, `gone:${goneNoticeId}`, convId, goneDev.id],
    );
    expect(
      await runNativePushJob({ runtime: worker, sender: captureSender(async () => 'gone').sender, orgId: o.orgId, notificationId: goneNoticeId }),
    ).toEqual({ sent: 0, gone: 1, failed: 0 });
    expect(await rows('SELECT 1 FROM ludy_kernel.native_push_device WHERE id = $1', [goneDev.id])).toHaveLength(0);

    // Non-upstream (JWT) mode expires devices inactive for > 30 days (no refresh or org activity) and evicts them without sending.
    const staleSess = randomUUID();
    const staleDev = await registerDevice(o.orgId, o.owner.userId, staleSess, { platform: 'apns', token: `apns-stale-${randomUUID()}` });
    await rows(
      "UPDATE ludy_kernel.native_push_device SET refreshed_at = now() - interval '31 days' WHERE id = $1",
      [staleDev.id],
    );
    await rows(
      "UPDATE ludy_kernel.auth_session_org SET last_seen_at = now() - interval '31 days' WHERE org_id = $1 AND user_id = $2 AND session_id = $3",
      [o.orgId, o.owner.userId, staleSess],
    );
    const staleNoticeId = randomUUID();
    await rows(
      `INSERT INTO ludy_kernel.notification (org_id, id, user_id, kind, dedupe_key, subject_type, subject_id, created_at)
       VALUES ($1, $2, $3, 'kernel.conversation_new', $4, 'kernel.conversation', $5, (SELECT created_at FROM ludy_kernel.native_push_device WHERE id = $6))`,
      [o.orgId, staleNoticeId, o.owner.userId, `stale-jwt:${staleNoticeId}`, convId, staleDev.id],
    );
    const staleSender = captureSender();
    expect(await runNativePushJob({ runtime: worker, sender: staleSender.sender, orgId: o.orgId, notificationId: staleNoticeId })).toEqual({
      sent: 0,
      gone: 1,
      failed: 0,
    });
    expect(staleSender.delivered).toEqual([]);
    expect(await rows('SELECT 1 FROM ludy_kernel.native_push_device WHERE id = $1', [staleDev.id])).toHaveLength(0);

    // Same-token re-registration between target resolution and record preserves the refreshed device despite unchanged generation.
    const reregSess = randomUUID();
    const reregTok = `apns-rereg-${randomUUID()}`;
    const reregDev = await registerDevice(o.orgId, o.owner.userId, reregSess, { platform: 'apns', token: reregTok });
    await rows("UPDATE ludy_kernel.native_push_device SET refreshed_at = now() - interval '31 days' WHERE id = $1", [reregDev.id]);
    await rows(
      "UPDATE ludy_kernel.auth_session_org SET last_seen_at = now() - interval '31 days' WHERE org_id = $1 AND user_id = $2 AND session_id = $3",
      [o.orgId, o.owner.userId, reregSess],
    );
    const reregProbeId = randomUUID();
    await rows(
      `INSERT INTO ludy_kernel.notification (org_id, id, user_id, kind, dedupe_key, subject_type, subject_id, created_at)
       VALUES ($1, $2, $3, 'kernel.conversation_new', $4, 'kernel.conversation', $5, (SELECT created_at FROM ludy_kernel.native_push_device WHERE id = $6))`,
      [o.orgId, reregProbeId, o.owner.userId, `rereg-probe:${reregProbeId}`, convId, reregDev.id],
    );
    expect((await targetsOf(o.orgId, reregProbeId))?.targets).toEqual([
      expect.objectContaining({ deviceId: reregDev.id, generation: 1, sessionValid: false }),
    ]);
    await rt.execute('kernel.notification.read', { ids: [reregProbeId] }, { actor: asUser(o.owner.userId), orgId: o.orgId });

    await registerDevice(o.orgId, o.owner.userId, reregSess, { platform: 'apns', token: reregTok });
    expect(
      await worker.execute(
        'kernel.native_push.record',
        { sent: [], gone: [], expired: [{ id: reregDev.id, generation: 1 }], failed: [], checkUpstream: false },
        { actor: SYSTEM, orgId: o.orgId },
      ),
    ).toEqual({ sent: 0, gone: 0, failed: 0 });
    expect(await rows('SELECT 1 FROM ludy_kernel.native_push_device WHERE id = $1', [reregDev.id])).toHaveLength(1);
    await rt.execute('kernel.native_push.unregister', { id: reregDev.id }, { actor: asUser(o.owner.userId, reregSess), orgId: o.orgId });

    // 5. Multi-device mid-dispatch revocation check: revoking device B while device A is sending prevents delivery to device B.
    const sessA = randomUUID();
    const sessB = randomUUID();
    const tokA = `apns-multi-a-${randomUUID()}`;
    const tokB = `fcm-multi-b-${randomUUID()}`;
    const devA = await registerDevice(o.orgId, o.owner.userId, sessA, { platform: 'apns', token: tokA });
    const devB = await registerDevice(o.orgId, o.owner.userId, sessB, { platform: 'fcm', token: tokB });
    const multiNoticeId = randomUUID();
    await rows(
      `INSERT INTO ludy_kernel.notification (org_id, id, user_id, kind, dedupe_key, subject_type, subject_id, created_at)
       VALUES ($1, $2, $3, 'kernel.conversation_new', $4, 'kernel.conversation', $5, (SELECT greatest(max(created_at), now()) FROM ludy_kernel.native_push_device WHERE id IN ($6, $7)))`,
      [o.orgId, multiNoticeId, o.owner.userId, `multi:${multiNoticeId}`, convId, devA.id, devB.id],
    );
    const sentTokens: string[] = [];
    const multiSender: NativePushSender = {
      id: 'multi-revoke-test',
      send: async (target) => {
        sentTokens.push(target.token);
        if (sentTokens.length === 1) {
          const activeSession = target.token === tokA ? sessA : sessB;
          const otherSession = target.token === tokA ? sessB : sessA;
          await rt.execute(
            'kernel.session.revoke',
            { userId: o.owner.userId, sessionId: otherSession },
            { actor: asUser(o.owner.userId, activeSession), orgId: o.orgId },
          );
        }
        return 'sent';
      },
    };
    expect(await runNativePushJob({ runtime: worker, sender: multiSender, orgId: o.orgId, notificationId: multiNoticeId })).toEqual({
      sent: 1,
      gone: 0,
      failed: 0,
    });
    expect(sentTokens).toHaveLength(1);
    const survivorId = sentTokens[0] === tokA ? devA.id : devB.id;
    const revokedDevId = sentTokens[0] === tokA ? devB.id : devA.id;
    expect(await rows('SELECT id FROM ludy_kernel.native_push_device WHERE id IN ($1, $2)', [devA.id, devB.id])).toEqual([
      { id: survivorId },
    ]);
    expect(await rows('SELECT 1 FROM ludy_kernel.native_push_device WHERE id = $1', [revokedDevId])).toHaveLength(0);
  });

  it('enforces legal-entity scope on conversation_new and offAppsOf on approval_waiting', async () => {
    const o = await org();
    const ownerDev = await registerDevice(o.orgId, o.owner.userId, randomUUID(), {
      platform: 'apns',
      token: `apns-le-owner-${randomUUID()}`,
      label: 'Owner Phone',
    });
    const memberDev = await registerDevice(o.orgId, o.member.userId, randomUUID(), {
      platform: 'fcm',
      token: `fcm-le-member-${randomUUID()}`,
      label: 'Member Phone',
    });
    const defaultLe = (
      await rows<{ id: string }>('SELECT id FROM ludy_kernel.legal_entity WHERE org_id = $1 AND is_default = true', [o.orgId])
    )[0]?.id as string;
    const secondLe = (
      await rows<{ id: string }>(
        "INSERT INTO ludy_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, 'Chi nhánh Push', 'branch', $2) RETURNING id",
        [o.orgId, o.owner.userId],
      )
    )[0]?.id as string;

    // Limit member to secondLe via an entity-scoped role assignment; defaultLe conversation notices must fail closed.
    await rows(
      "INSERT INTO ludy_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by) VALUES ($1, $2, 'external_accountant', $3, $4)",
      [o.orgId, o.member.userId, secondLe, o.owner.userId],
    );
    const outOfScopeNoticeId = randomUUID();
    const inScopeNoticeId = randomUUID();
    await rows(
      `INSERT INTO ludy_kernel.notification (org_id, id, user_id, kind, dedupe_key, subject_type, subject_id, legal_entity_id, created_at)
       VALUES ($1, $2, $3, 'kernel.conversation_new', $4, NULL, NULL, $5, (SELECT created_at + interval '1 second' FROM ludy_kernel.native_push_device WHERE id = $6))`,
      [o.orgId, outOfScopeNoticeId, o.member.userId, `conv-le-out:${outOfScopeNoticeId}`, defaultLe, memberDev.id],
    );
    await rows(
      `INSERT INTO ludy_kernel.notification (org_id, id, user_id, kind, dedupe_key, subject_type, subject_id, legal_entity_id, created_at)
       VALUES ($1, $2, $3, 'kernel.conversation_new', $4, NULL, NULL, $5, (SELECT created_at + interval '1 second' FROM ludy_kernel.native_push_device WHERE id = $6))`,
      [o.orgId, inScopeNoticeId, o.member.userId, `conv-le-in:${inScopeNoticeId}`, secondLe, memberDev.id],
    );
    expect(await targetsOf(o.orgId, outOfScopeNoticeId)).toBeNull();
    expect(await targetsOf(o.orgId, inScopeNoticeId)).toMatchObject({ kind: 'kernel.conversation_new', targets: [{ deviceId: memberDev.id }] });

    // Switching off an app (ads) suppresses pending approval notices for that app's commands.
    const adsProposalId = (
      await rows<{ id: string }>(
        `INSERT INTO ludy_kernel.proposal (org_id, kind, command, status, title, payload, legal_entity_id, eligible_approvers, authors)
         VALUES ($1, 'ads.write.enable', 'ads.write.enable', 'pending', 'Ads Off Check', '{}'::jsonb, $2, $3::uuid[], $4::jsonb)
         RETURNING id`,
        [o.orgId, defaultLe, [o.owner.userId], JSON.stringify([{ type: 'user', id: o.admin.userId }])],
      )
    )[0]?.id as string;
    const adsNoticeId = randomUUID();
    await rows(
      `INSERT INTO ludy_kernel.notification (org_id, id, user_id, kind, dedupe_key, subject_type, subject_id, legal_entity_id, created_at)
       VALUES ($1, $2, $3, 'kernel.approval_waiting', $4, 'kernel.proposal', $5, $6, (SELECT created_at + interval '1 second' FROM ludy_kernel.native_push_device WHERE id = $7))`,
      [o.orgId, adsNoticeId, o.owner.userId, `ads-off:${adsNoticeId}`, adsProposalId, defaultLe, ownerDev.id],
    );
    expect(await targetsOf(o.orgId, adsNoticeId)).toMatchObject({ kind: 'kernel.approval_waiting', targets: [{ deviceId: ownerDev.id }] });

    await rt.execute('kernel.org.set_app', { module: 'ads', enabled: false }, { actor: asUser(o.owner.userId, randomUUID(), true), orgId: o.orgId });
    expect(await targetsOf(o.orgId, adsNoticeId)).toBeNull();
  });
});

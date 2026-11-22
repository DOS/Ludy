// SPDX-License-Identifier: AGPL-3.0-only
// PostgreSQL 17 integration suite for Projects Public Roadmap Slice 1 (#4399, ADR-0057, ADR-0053, #203):
//   - Opaque 404 parity across unknown org/board, board.enabled=false, org_app_on('projects')=false, unentitled org
//   - Strict ?embed=1 CSP frame-ancestors (default 'none', explicit HTTPS allowlist, #203 zero Turnstile)
//   - 2 KB / 16 KB body limits, no-store, Referrer-Policy: no-referrer, cross-board claim isolation
//   - Zero-login browse + 6-digit email OTP (mail_message zero plaintext PII -> worker otp_mail_data -> 5-attempt lock)
//   - mail_suppression check without suppression oracle + IP/email rate limiting (429 + Retry-After)
//   - Idea submission taint/moderation + duplicate vote-dedup merge + convert-to-task + stage sync
//   - Private project guard (#2604 forward-compatibility DB trigger + runtime refusal) & template refusal
//   - Nightly OTP keeping sweep with Projects off, subscriber sealed email + unsubscribe, PDPL find/erase
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import {
  DEFAULT_MESSAGE_ID_DOMAIN,
  createOrg,
  kernelCommands,
  kernelQueries,
  upsertIdentity,
} from '@ludy/kernel';
import { ROADMAP_PAGE_PREFIX, ROADMAP_VOTER_HEADER } from '@ludy/kernel-contract';
import {
  Runtime,
  contentGeneration,
  sha256Hex,
  type BlobStore,
} from '@ludy/kernel-runtime';
import type { MailProvider, OutboundMail } from '@ludy/mail';
import { projectsCommands, projectsQueries } from '@ludy/mod-projects';
import { createAuthenticator } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { createCredentialBroker } from '../src/credentials.ts';
import { TURNSTILE_ORIGIN, createHttpApp } from '../src/http.ts';
import { runMailJob } from '../src/mail-queue.ts';
import { MAIL_TEMPLATES } from '../src/mail-templates.ts';
import { orgPurgeCommand, runOrgPurge } from '../src/org-purge.ts';
import { roadmapIpHash } from '../src/projects-public-roadmap.ts';
import { sweepRoadmapOtpCleanup } from '../src/projects-roadmap-worker.ts';
import { RateLimiter } from '../src/rate-limit.ts';
import { createSessionStatusSource } from '../src/sessions.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const JWT_SIGNING_KEY = 'test-only-jwt-key-projects-roadmap-4399-0123456789';
const CREDENTIAL_KEY_B64 = randomBytes(32).toString('base64');
const ISSUER = 'crove-auth';
const suite = ADMIN ? describe : describe.skip;

class MemoryStore implements BlobStore {
  readonly blobs = new Map<string, Uint8Array>();

  async put(key: string, bytes: Uint8Array) {
    this.blobs.set(key, bytes);
    return contentGeneration(sha256Hex(bytes));
  }

  async get(key: string) {
    const found = this.blobs.get(key);
    if (!found) throw new Error(`missing blob: ${key}`);
    return found;
  }

  async delete(key: string) {
    this.blobs.delete(key);
  }
}

function extractSixDigitCode(text: string): string {
  const code = /\b(\d{6})\b/.exec(text)?.[1];
  expect(code).toMatch(/^\d{6}$/);
  return code as string;
}

function assertPublicHeaders(res: Response) {
  expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  expect(res.headers.get('cache-control')).toBe('no-store');
  expect(res.headers.get('x-content-type-options')).toBe('nosniff');
}

async function mintUserJwt(subject: string, email: string): Promise<string> {
  return new SignJWT({
    role: 'authenticated',
    email,
    session_id: randomUUID(),
    aal: 'aal1',
    is_anonymous: false,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(ISSUER)
    .setAudience('authenticated')
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(new TextEncoder().encode(JWT_SIGNING_KEY));
}

suite('Projects Public Roadmap Slice 1 (#4399)', () => {
  const dbName = `crove_test_roadmap_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let tmpWebDist = '';
  let adminUrl = '';
  let appPool: pg.Pool | undefined;
  let workerPool: pg.Pool | undefined;
  let workerDb!: Db;
  let runtime!: Runtime;
  let workerRuntime!: Runtime;
  let app!: ReturnType<typeof createHttpApp>;
  let appUnentitled!: ReturnType<typeof createHttpApp>;
  let appNoBroker!: ReturnType<typeof createHttpApp>;
  let broker!: ReturnType<typeof createCredentialBroker>;
  const store = new MemoryStore();

  let orgId = '';
  let orgSlug = '';
  let otherOrgId = '';
  let ownerUserId = '';
  let adminUserId = '';
  let memberUserId = '';
  let viewerUserId = '';
  let memberPosId = '';

  const asOwner = () => ({ type: 'user' as const, userId: ownerUserId, sessionId: randomUUID(), aal: 'aal1' as const });
  const asAdmin = () => ({ type: 'user' as const, userId: adminUserId, sessionId: randomUUID(), aal: 'aal1' as const });
  const asMember = () => ({ type: 'user' as const, userId: memberUserId, sessionId: randomUUID(), aal: 'aal1' as const });
  const asViewer = () => ({ type: 'user' as const, userId: viewerUserId, sessionId: randomUUID(), aal: 'aal1' as const });
  const asOwnerMfa = () => ({ type: 'user' as const, userId: ownerUserId, sessionId: randomUUID(), aal: 'aal2' as const, mfaAt: Math.floor(Date.now() / 1000) });

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }

  async function postJson(
    targetApp: ReturnType<typeof createHttpApp>,
    path: string,
    body: unknown,
    opts?: { ip?: string; voterToken?: string; bearer?: string },
  ): Promise<Response> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-forwarded-for': opts?.ip ?? '198.51.100.10',
      'user-agent': 'ProjectsRoadmapTest/1.0',
    };
    if (opts?.voterToken) headers[ROADMAP_VOTER_HEADER] = opts.voterToken;
    if (opts?.bearer) headers.authorization = `Bearer ${opts.bearer}`;
    return targetApp.request(path, {
      method: 'POST',
      headers,
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  }

  async function getBoard(
    targetApp: ReturnType<typeof createHttpApp>,
    oSlug: string,
    bSlug: string,
    opts?: { ip?: string; voterToken?: string; bearer?: string },
  ): Promise<Response> {
    const headers: Record<string, string> = {
      'x-forwarded-for': opts?.ip ?? '198.51.100.10',
      'user-agent': 'ProjectsRoadmapTest/1.0',
    };
    if (opts?.voterToken) headers[ROADMAP_VOTER_HEADER] = opts.voterToken;
    if (opts?.bearer) headers.authorization = `Bearer ${opts.bearer}`;
    return targetApp.request(`/api/projects/public-roadmap/${oSlug}/${bSlug}`, {
      method: 'GET',
      headers,
    });
  }

  beforeAll(async () => {
    tmpWebDist = mkdtempSync(join(tmpdir(), 'crove-roadmap-web-'));
    writeFileSync(join(tmpWebDist, 'index.html'), '<!doctype html><html><body>Ludy Public Roadmap</body></html>', 'utf8');

    const root = new pg.Client({ connectionString: ADMIN as string });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();

    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();

    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { ludy_app: 'roadmap-app-pw', ludy_worker: 'roadmap-worker-pw' });

    const login = (u: string, pw: string) => {
      const url = new URL(adminUrl);
      url.username = u;
      url.password = pw;
      return url.toString();
    };

    const appUrl = login('ludy_app', 'roadmap-app-pw');
    const workerUrl = login('ludy_worker', 'roadmap-worker-pw');
    appPool = createPool({ connectionString: appUrl, max: 6 });
    workerPool = createPool({ connectionString: workerUrl, max: 3 });

    const appDb = createDb(appPool);
    workerDb = createDb(workerPool);

    runtime = new Runtime(appDb, { manifests: TEST_MANIFESTS, sessions: createSessionStatusSource('off'), stepUp: 'off' })
      .register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: null }) })
      .register({ commands: projectsCommands, queries: projectsQueries });

    workerRuntime = new Runtime(workerDb, { manifests: TEST_MANIFESTS })
      .register({ commands: [...kernelCommands, orgPurgeCommand({ store })], queries: kernelQueries({ inboundDomain: null }) })
      .register({ commands: projectsCommands, queries: projectsQueries });

    const config = loadConfig({
      DATABASE_URL: appUrl,
      AUTH_JWT_SECRET: JWT_SIGNING_KEY,
      AUTH_ISSUER: ISSUER,
      AUTH_SESSION_CHECK: 'off',
      PUBLIC_URL: 'http://localhost:8080',
      MIGRATIONS_DIR: MIGRATIONS,
      WEB_DIST: tmpWebDist,
      TRUSTED_PROXY_HOPS: '1',
      CREDENTIAL_KEY: CREDENTIAL_KEY_B64,
    });
    broker = createCredentialBroker(config);

    const noBrokerConfig = loadConfig({
      DATABASE_URL: appUrl,
      AUTH_JWT_SECRET: JWT_SIGNING_KEY,
      AUTH_ISSUER: ISSUER,
      AUTH_SESSION_CHECK: 'off',
      PUBLIC_URL: 'http://localhost:8080',
      MIGRATIONS_DIR: MIGRATIONS,
      WEB_DIST: tmpWebDist,
      TRUSTED_PROXY_HOPS: '1',
    });

    const authenticate = createAuthenticator(config, appDb);
    app = createHttpApp({
      config,
      runtime,
      store,
      authenticate,
      pool: appPool,
      broker,
      aiEnabled: false,
      billing: { entitlements: async () => ['full'] },
    });

    appUnentitled = createHttpApp({
      config,
      runtime,
      store,
      authenticate,
      pool: appPool,
      broker,
      aiEnabled: false,
      billing: { entitlements: async () => [] },
    });

    appNoBroker = createHttpApp({
      config: noBrokerConfig,
      runtime,
      store,
      authenticate,
      pool: appPool,
      broker: createCredentialBroker(noBrokerConfig),
      aiEnabled: false,
      billing: { entitlements: async () => ['full'] },
    });

    ownerUserId = await upsertIdentity(appDb, {
      issuer: ISSUER,
      subject: 'rm-owner',
      email: 'owner-rm@example.test',
      name: 'Owner Roadmap',
    });
    adminUserId = await upsertIdentity(appDb, {
      issuer: ISSUER,
      subject: 'rm-admin',
      email: 'admin-rm@example.test',
      name: 'Admin Roadmap',
    });
    memberUserId = await upsertIdentity(appDb, {
      issuer: ISSUER,
      subject: 'rm-member',
      email: 'member-rm@example.test',
      name: 'Member Roadmap',
    });
    viewerUserId = await upsertIdentity(appDb, {
      issuer: ISSUER,
      subject: 'rm-viewer',
      email: 'viewer-rm@example.test',
      name: 'Viewer Roadmap',
    });

    const org = await createOrg(runtime, asOwner(), 'Cong ty Lo Trinh');
    orgId = org.orgId;
    orgSlug = org.slug;

    const otherOrg = await createOrg(runtime, asOwner(), 'Cong ty Khac');
    otherOrgId = otherOrg.orgId;

    await admin(async (c) => {
      await c.query(
        `INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'viewer')`,
        [orgId, adminUserId, memberUserId, viewerUserId],
      );
      const { rows: posRows } = await c.query<{ id: string }>(
        `INSERT INTO ludy_kernel.position (org_id, title, module, role_key, holder_user_id) VALUES ($1, 'Product Lead', 'kernel', 'member', $2) RETURNING id`,
        [orgId, memberUserId],
      );
      memberPosId = posRows[0]!.id;
    });
  }, 120_000);

  afterAll(async () => {
    await appPool?.end();
    await workerPool?.end();
    if (tmpWebDist) rmSync(tmpWebDist, { recursive: true, force: true });
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('enforces opaque 404 parity, strict ?embed=1 CSP frame-ancestors, #203 zero Turnstile, and body caps', async () => {
    // Null/blank IPs never collapse into a shared 'unknown' rate-limit bucket.
    expect(roadmapIpHash(null)).toBeNull();
    expect(roadmapIpHash('   ')).toBeNull();
    expect(roadmapIpHash('198.51.100.1')).toMatch(/^[0-9a-f]{64}$/);
    // Viewer and member cannot create or configure public boards (admin/owner R2 gate).
    await expect(
      runtime.execute('projects.roadmap.board.create', { title: 'Test' }, { actor: asMember(), orgId, idempotencyKey: randomUUID() }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      runtime.execute('projects.roadmap.board.create', { title: 'Test' }, { actor: asViewer(), orgId, idempotencyKey: randomUUID() }),
    ).rejects.toMatchObject({ status: 403 });

    const created = await runtime.execute<{ board: { id: string; slug: string; enabled: boolean } }>(
      'projects.roadmap.board.create',
      {
        title: 'Lo trinh Cong khai',
        slug: 'main',
        enabled: false,
        embedAllowedOrigins: ['https://portal.example.com', 'https://docs.example.com:8443'],
      },
      { actor: asOwner(), orgId, idempotencyKey: randomUUID() },
    );
    expect(created.board.enabled).toBe(false);

    // Non-embed SPA page serves frame-ancestors 'none' and zero Turnstile origin (#203).
    const pageStandalone = await app.request(`${ROADMAP_PAGE_PREFIX}/${orgSlug}/main`, { method: 'GET' });
    expect(pageStandalone.status).toBe(200);
    const standaloneCsp = pageStandalone.headers.get('content-security-policy') ?? '';
    expect(standaloneCsp).toContain("frame-ancestors 'none'");
    expect(standaloneCsp).not.toContain(TURNSTILE_ORIGIN);

    // While board.enabled=false, ?embed=1 ALSO locks frame-ancestors 'none' and API returns opaque 404.
    const embedDisabled = await app.request(`${ROADMAP_PAGE_PREFIX}/${orgSlug}/main?embed=1`, { method: 'GET' });
    expect(embedDisabled.status).toBe(200);
    expect(embedDisabled.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");

    expect((await getBoard(app, orgSlug, 'main')).status).toBe(404);
    expect((await getBoard(app, orgSlug, 'unknown-board')).status).toBe(404);
    expect((await getBoard(app, 'unknown-org-slug', 'main')).status).toBe(404);
    expect((await postJson(app, `/api/projects/public-roadmap/${orgSlug}/main/otp/request`, { email: 'a@example.test' })).status).toBe(404);

    // Enable the board: API opens up and ?embed=1 returns the exact allowlisted HTTPS origins!
    await runtime.execute(
      'projects.roadmap.board.update',
      { boardId: created.board.id, enabled: true },
      { actor: asAdmin(), orgId, idempotencyKey: randomUUID() },
    );
    const liveGet = await getBoard(app, orgSlug, 'main');
    expect(liveGet.status).toBe(200);
    assertPublicHeaders(liveGet);

    const embedLive = await app.request(`${ROADMAP_PAGE_PREFIX}/${orgSlug}/main?embed=1`, { method: 'GET' });
    expect(embedLive.status).toBe(200);
    expect(embedLive.headers.get('content-security-policy')).toContain(
      'frame-ancestors https://portal.example.com https://docs.example.com:8443',
    );
    expect(embedLive.headers.get('content-security-policy')).not.toContain(TURNSTILE_ORIGIN);

    // Empty embedAllowedOrigins fails closed to frame-ancestors 'none'.
    await runtime.execute(
      'projects.roadmap.board.update',
      { boardId: created.board.id, embedAllowedOrigins: [] },
      { actor: asOwner(), orgId, idempotencyKey: randomUUID() },
    );
    const embedEmpty = await app.request(`${ROADMAP_PAGE_PREFIX}/${orgSlug}/main?embed=1`, { method: 'GET' });
    expect(embedEmpty.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    await runtime.execute(
      'projects.roadmap.board.update',
      { boardId: created.board.id, embedAllowedOrigins: ['https://portal.example.com'] },
      { actor: asOwner(), orgId, idempotencyKey: randomUUID() },
    );

    // Unentitled org -> identical opaque 404 across GET, POST, and ?embed=1 CSP fallback.
    expect((await getBoard(appUnentitled, orgSlug, 'main')).status).toBe(404);
    expect((await postJson(appUnentitled, `/api/projects/public-roadmap/${orgSlug}/main/otp/request`, { email: 'a@example.test' })).status).toBe(404);
    expect((await appUnentitled.request(`${ROADMAP_PAGE_PREFIX}/${orgSlug}/main?embed=1`)).headers.get('content-security-policy')).toContain(
      "frame-ancestors 'none'",
    );

    // org_app_on('projects') = false -> identical opaque 404 and ?embed=1 fallback.
    await runtime.execute('kernel.org.set_app', { module: 'projects', enabled: false }, { actor: asOwner(), orgId });
    try {
      expect((await getBoard(app, orgSlug, 'main')).status).toBe(404);
      expect((await postJson(app, `/api/projects/public-roadmap/${orgSlug}/main/otp/request`, { email: 'a@example.test' })).status).toBe(404);
      expect((await app.request(`${ROADMAP_PAGE_PREFIX}/${orgSlug}/main?embed=1`)).headers.get('content-security-policy')).toContain(
        "frame-ancestors 'none'",
      );
    } finally {
      await runtime.execute('kernel.org.set_app', { module: 'projects', enabled: true }, { actor: asOwner(), orgId });
    }

    // 2 KB body cap on /otp/request and 16 KB body cap on /ideas.
    const hugeOtp = await postJson(app, `/api/projects/public-roadmap/${orgSlug}/main/otp/request`, {
      email: 'khach@example.test',
      pad: 'x'.repeat(3000),
    });
    expect(hugeOtp.status).toBe(413);

    const hugeIdea = await postJson(app, `/api/projects/public-roadmap/${orgSlug}/main/ideas`, {
      title: 'x'.repeat(17_000),
    });
    expect(hugeIdea.status).toBe(413);
  });

  it('runs end-to-end 6-digit OTP voting, suppression check, 5-attempt lockout, ideas moderation, merge deduplication, and task handoff', async () => {
    const secondBoard = await runtime.execute<{ board: { id: string; slug: string } }>(
      'projects.roadmap.board.create',
      {
        title: 'Bang y tuong thu hai',
        slug: 'portal',
        enabled: true,
        requireModeration: true,
      },
      { actor: asOwner(), orgId, idempotencyKey: randomUUID() },
    );
    const boardId = secondBoard.board.id;

    // Seed an internal project & an internal roadmap item.
    const proj = await runtime.execute<{ projectId: string }>(
      'projects.project.create',
      { name: 'Du an san pham chinh' },
      { actor: asMember(), orgId },
    );

    const internalItem = await runtime.execute<{ item: { id: string; stage: string; moderationStatus: string } }>(
      'projects.roadmap.item.create',
      {
        boardId,
        publicTitle: 'Che do toi (Dark mode)',
        publicSummary: 'Ho tro giao dien toi cho ca ngay va dem.',
        category: 'UI',
        stage: 'planned',
        moderationStatus: 'published',
      },
      { actor: asMember(), orgId, idempotencyKey: randomUUID() },
    );
    const itemAId = internalItem.item.id;

    const sentMails: OutboundMail[] = [];
    const mailer: MailProvider = {
      name: 'test_smtp',
      enabled: true,
      sendRetrySafety: 'idempotent',
      async send(mail) {
        sentMails.push(mail);
        return { status: 'accepted', providerMessageId: randomUUID() };
      },
      parseWebhook: () => [],
    };
    const drainMails = async () => {
      const queued = await admin(async (c) => {
        const { rows } = await c.query<{ id: string }>(
          `SELECT id FROM ludy_kernel.mail_message WHERE org_id = $1 AND status = 'queued' ORDER BY created_at ASC`,
          [orgId],
        );
        return rows;
      });
      for (const row of queued) {
        await runMailJob(
          {
            workerDb,
            runtime: workerRuntime,
            mailer,
            templates: MAIL_TEMPLATES,
            store,
            publicUrl: 'http://localhost:8080',
            bounceDomain: DEFAULT_MESSAGE_ID_DOMAIN,
          },
          { orgId, messageId: row.id },
        );
      }
    };

    // Suppressed recipient skips mail delivery while returning opaque sent=true response and indistinguishable 401 attempts on verify.
    const suppressedEmail = 'suppressed-voter@example.test';
    await admin(async (c) => {
      await c.query(
        `INSERT INTO ludy_kernel.mail_suppression (org_id, to_hash, scope, reason)
         VALUES ($1, ludy_kernel.mail_address_hash($2), 'all', 'hard_bounce')`,
        [orgId, suppressedEmail],
      );
    });
    const supRes = await postJson(
      app,
      `/api/projects/public-roadmap/${orgSlug}/portal/otp/request`,
      { email: suppressedEmail },
      { ip: '198.51.100.51' },
    );
    expect(supRes.status).toBe(200);
    await drainMails();
    expect(sentMails).toHaveLength(0);

    const supVerifyAttempt = await postJson(
      app,
      `/api/projects/public-roadmap/${orgSlug}/portal/otp/verify`,
      { email: suppressedEmail, code: '123456' },
      { ip: '198.51.100.51' },
    );
    expect(supVerifyAttempt.status).toBe(401);
    await expect(supVerifyAttempt.json()).resolves.toMatchObject({ ok: false, locked: false, attemptsRemaining: 4 });

    // Active voter OTP flow: zero plaintext OTP or email inside mail_message.payload before worker runs.
    const voter1 = 'voter-one@example.test';
    const otpReq1 = await postJson(
      app,
      `/api/projects/public-roadmap/${orgSlug}/portal/otp/request`,
      { email: voter1 },
      { ip: '198.51.100.52' },
    );
    expect(otpReq1.status).toBe(200);
    const reqJson = (await otpReq1.json()) as { sent: boolean; maskedEmail: string };
    expect(reqJson.sent).toBe(true);
    expect(reqJson.maskedEmail).toContain('@example.test');

    await admin(async (c) => {
      const { rows: otpRows } = await c.query<{ otp_sha256: string | null; email: string }>(
        `SELECT otp_sha256, email FROM ludy_projects.roadmap_otp WHERE org_id = $1 AND board_id = $2 ORDER BY created_at DESC LIMIT 1`,
        [orgId, boardId],
      );
      expect(otpRows[0]!.otp_sha256).toBeNull();
      const { rows: mailRows } = await c.query<{ payload: Record<string, unknown> }>(
        `SELECT payload FROM ludy_kernel.mail_message WHERE org_id = $1 AND status = 'queued' ORDER BY created_at DESC LIMIT 1`,
        [orgId],
      );
      expect(JSON.stringify(mailRows[0]!.payload)).not.toContain(voter1);
    });

    // Security check: ludy_app/ludy_tenant has zero direct SQL access to MACHINERY tables roadmap_otp & roadmap_subscriber.
    const appClient = await appPool!.connect();
    try {
      await expect(appClient.query('SELECT count(*) FROM ludy_projects.roadmap_otp')).rejects.toThrow();
      await expect(appClient.query('SELECT count(*) FROM ludy_projects.roadmap_subscriber')).rejects.toThrow();
    } finally {
      appClient.release();
    }

    await drainMails();
    expect(sentMails).toHaveLength(1);
    const code1 = extractSixDigitCode(sentMails[0]!.text);

    // 5 wrong attempts lock the OTP challenge; even the valid 6-digit code fails afterwards.
    const lockEmail = 'lock-voter@example.test';
    await postJson(
      app,
      `/api/projects/public-roadmap/${orgSlug}/portal/otp/request`,
      { email: lockEmail },
      { ip: '198.51.100.53' },
    );
    await drainMails();
    const lockCode = extractSixDigitCode(sentMails.at(-1)!.text);
    const wrongCode = lockCode === '000000' ? '111111' : '000000';
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const badRes = await postJson(
        app,
        `/api/projects/public-roadmap/${orgSlug}/portal/otp/verify`,
        { email: lockEmail, code: wrongCode },
        { ip: '198.51.100.53' },
      );
      expect(badRes.status).toBe(401);
      await expect(badRes.json()).resolves.toMatchObject({ ok: false, locked: false, attemptsRemaining: 5 - attempt });
    }
    const fifthRes = await postJson(
      app,
      `/api/projects/public-roadmap/${orgSlug}/portal/otp/verify`,
      { email: lockEmail, code: wrongCode },
      { ip: '198.51.100.53' },
    );
    expect(fifthRes.status).toBe(423);
    await expect(fifthRes.json()).resolves.toMatchObject({ ok: false, locked: true, attemptsRemaining: 0 });
    const afterLockRes = await postJson(
      app,
      `/api/projects/public-roadmap/${orgSlug}/portal/otp/verify`,
      { email: lockEmail, code: lockCode },
      { ip: '198.51.100.53' },
    );
    expect(afterLockRes.status).toBe(423);

    // Verify valid voter1 code and mint HMAC voter claim.
    const ver1 = await postJson(
      app,
      `/api/projects/public-roadmap/${orgSlug}/portal/otp/verify`,
      { email: voter1, code: code1 },
      { ip: '198.51.100.52' },
    );
    expect(ver1.status).toBe(200);
    const ver1Json = (await ver1.json()) as { ok: boolean; voterToken: string };
    expect(ver1Json.ok).toBe(true);
    expect(ver1Json.voterToken).toMatch(/^rm1\./);

    // Cross-board isolation: voter1's claim on 'portal' cannot be used on 'main'.
    const crossVote = await postJson(
      app,
      `/api/projects/public-roadmap/${orgSlug}/main/votes`,
      { itemId: itemAId, action: 'vote' },
      { ip: '198.51.100.52', voterToken: ver1Json.voterToken },
    );
    expect(crossVote.status).toBe(401);

    // Unverified submission is refused (401); verified voter submission starts tainted=true + moderation_status='pending'.
    const unauthIdea = await postJson(
      app,
      `/api/projects/public-roadmap/${orgSlug}/portal/ideas`,
      { title: 'Blocked anonymous idea' },
      { ip: '198.51.100.52' },
    );
    expect(unauthIdea.status).toBe(401);

    const subIdea = await postJson(
      app,
      `/api/projects/public-roadmap/${orgSlug}/portal/ideas`,
      {
        title: 'Xuat bao cao PDF hang loat',
        summary: 'Cho phep tai ve file PDF nhieu hoa don cung luc.',
        category: 'Bao cao',
        displayName: 'Minh Khach',
      },
      { ip: '198.51.100.52', voterToken: ver1Json.voterToken },
    );
    expect(subIdea.status).toBe(201);
    const subJson = (await subIdea.json()) as {
      item: { id: string; moderationStatus: string; tainted: boolean };
    };
    const itemBId = subJson.item.id;
    expect(subJson.item.moderationStatus).toBe('pending');
    expect(subJson.item.tainted).toBe(true);

    // Pending item is invisible on public GET until published.
    const pubBeforePublish = (await (await getBoard(app, orgSlug, 'portal')).json()) as {
      items: Array<{ id: string }>;
    };
    expect(pubBeforePublish.items.map((i) => i.id)).toEqual([itemAId]);

    await runtime.execute(
      'projects.roadmap.item.moderate',
      { itemId: itemBId, moderationStatus: 'published', stage: 'under_review' },
      { actor: asMember(), orgId, idempotencyKey: randomUUID() },
    );

    // Upvote toggle + fail-closed broker check + sealed subscriber email + unsubscribe.
    const memberJwtForNoBroker = await mintUserJwt('rm-member', 'member-rm@example.test');
    const failNoBroker = await postJson(
      appNoBroker,
      `/api/projects/public-roadmap/${orgSlug}/portal/votes`,
      { itemId: itemAId, action: 'vote', notifyOnShip: true },
      { ip: '198.51.100.52', bearer: memberJwtForNoBroker },
    );
    expect(failNoBroker.status).toBe(503);

    const voteA1 = await postJson(
      app,
      `/api/projects/public-roadmap/${orgSlug}/portal/votes`,
      { itemId: itemAId, action: 'vote', notifyOnShip: true },
      { ip: '198.51.100.52', voterToken: ver1Json.voterToken },
    );
    expect(voteA1.status).toBe(200);
    await expect(voteA1.json()).resolves.toMatchObject({ itemId: itemAId, voted: true, voteCount: 1, notifyOnShip: true });

    // Confirm subscriber email was sealed using CredentialBroker (never stored in plaintext).
    const unsubToken = 'unsub-secret-token-0123456789abcdef';
    await admin(async (c) => {
      const { rows } = await c.query<{ id: string; email_sealed: string; notify_on_ship: boolean }>(
        `SELECT id, email_sealed, notify_on_ship FROM ludy_projects.roadmap_subscriber WHERE org_id = $1 AND board_id = $2`,
        [orgId, boardId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.email_sealed.startsWith('crove:cs1:')).toBe(true);
      expect(rows[0]!.email_sealed).not.toContain(voter1);
      expect(rows[0]!.notify_on_ship).toBe(true);
      await c.query(`UPDATE ludy_projects.roadmap_subscriber SET unsubscribe_token_sha256 = $1 WHERE id = $2`, [
        sha256Hex(unsubToken),
        rows[0]!.id,
      ]);
    });

    // POST unsubscribe opts out cleanly and idempotently.
    const unsubRes = await postJson(
      app,
      `/api/projects/public-roadmap/${orgSlug}/portal/votes`,
      { action: 'unsubscribe', unsubscribeToken: unsubToken },
      { ip: '198.51.100.52' },
    );
    expect(unsubRes.status).toBe(200);
    await admin(async (c) => {
      const { rows } = await c.query<{ notify_on_ship: boolean; unsubscribed_at: string | null }>(
        `SELECT notify_on_ship, unsubscribed_at FROM ludy_projects.roadmap_subscriber WHERE org_id = $1 AND board_id = $2`,
        [orgId, boardId],
      );
      expect(rows[0]!.notify_on_ship).toBe(false);
      expect(rows[0]!.unsubscribed_at).not.toBeNull();
    });

    // Duplicate merge deduplication: voter1 votes on itemB too, and workspace member (voter2) votes ONLY on itemB.
    await postJson(
      app,
      `/api/projects/public-roadmap/${orgSlug}/portal/votes`,
      { itemId: itemBId, action: 'vote' },
      { ip: '198.51.100.52', voterToken: ver1Json.voterToken },
    );
    const memberJwt = await mintUserJwt('rm-member', 'member-rm@example.test');
    const voteMemberB = await postJson(
      app,
      `/api/projects/public-roadmap/${orgSlug}/portal/votes`,
      { itemId: itemBId, action: 'vote' },
      { ip: '198.51.100.54', bearer: memberJwt },
    );
    expect(voteMemberB.status).toBe(200);
    await expect(voteMemberB.json()).resolves.toMatchObject({ itemId: itemBId, voted: true, voteCount: 2 });

    // Merge itemB into itemA: voter1 overlapped, so total deduplicated votes on itemA = 2 (NOT 3).
    const merged = await runtime.execute<{
      sourceItem: { moderationStatus: string; voteCount: number; mergedIntoItemId: string | null };
      targetItem: { voteCount: number };
    }>(
      'projects.roadmap.item.merge',
      { sourceItemId: itemBId, targetItemId: itemAId },
      { actor: asAdmin(), orgId, idempotencyKey: randomUUID() },
    );
    expect(merged.sourceItem.moderationStatus).toBe('merged');
    expect(merged.sourceItem.voteCount).toBe(0);
    expect(merged.sourceItem.mergedIntoItemId).toBe(itemAId);
    expect(merged.targetItem.voteCount).toBe(2);

    // Convert merged target itemA to an internal team task without leaking internal task notes/assignee on public GET.
    const converted = await runtime.execute<{ taskId: string; item: { stage: string; linkedTaskId: string } }>(
      'projects.roadmap.item.convert_to_task',
      { itemId: itemAId, projectId: proj.projectId, assigneePositionId: memberPosId },
      { actor: asAdmin(), orgId, idempotencyKey: randomUUID() },
    );
    expect(converted.item.linkedTaskId).toBe(converted.taskId);

    // Verify task retains tainted = true when created from roadmap item, add an internal private comment, and assert public GET leaks nothing internal.
    await runtime.execute(
      'kernel.task.comment',
      { id: converted.taskId, body: 'Ghi chu noi bo tuyet mat: can 3 ngay ky thuat' },
      { actor: asMember(), orgId },
    );
    await admin(async (c) => {
      const { rows } = await c.query<{ tainted: boolean; source_ref: { type: string; id: string } }>(
        `SELECT tainted, source_ref FROM ludy_kernel.task WHERE org_id = $1 AND id = $2`,
        [orgId, converted.taskId],
      );
      expect(rows[0]!.tainted).toBe(true);
      expect(rows[0]!.source_ref).toEqual({ type: 'projects.roadmap_item', id: itemAId });
    });

    const pubAfterConvert = await getBoard(app, orgSlug, 'portal');
    const pubJsonAfterConvert = await pubAfterConvert.text();
    expect(pubJsonAfterConvert).not.toContain('Ghi chu noi bo tuyet mat');
    expect(pubJsonAfterConvert).not.toContain(converted.taskId);
    expect(pubJsonAfterConvert).not.toContain(memberPosId);
    expect(pubJsonAfterConvert).not.toContain('Product Lead');

    // Task status transitions sync roadmap stage cleanly via projects.roadmap.item.sync_stage.
    await runtime.execute(
      'kernel.task.set_status',
      { id: converted.taskId, status: 'in_progress' },
      { actor: asMember(), orgId },
    );
    const syncedInProg = await runtime.execute<{ item: { stage: string } }>(
      'projects.roadmap.item.sync_stage',
      { itemId: itemAId },
      { actor: asMember(), orgId, idempotencyKey: randomUUID() },
    );
    expect(syncedInProg.item.stage).toBe('in_progress');

    await runtime.execute(
      'kernel.task.set_status',
      { id: converted.taskId, status: 'done' },
      { actor: asMember(), orgId },
    );
    const syncedDone = await runtime.execute<{ item: { stage: string } }>(
      'projects.roadmap.item.sync_stage',
      { itemId: itemAId },
      { actor: asMember(), orgId, idempotencyKey: randomUUID() },
    );
    expect(syncedDone.item.stage).toBe('shipped');

    // IP rate limiting on public endpoints returns 429 + Retry-After >= 1.
    const tightConfig = loadConfig({
      DATABASE_URL: 'postgres://localhost/unused',
      AUTH_JWT_SECRET: JWT_SIGNING_KEY,
      AUTH_ISSUER: ISSUER,
      AUTH_SESSION_CHECK: 'off',
      PUBLIC_URL: 'http://localhost:8080',
      MIGRATIONS_DIR: MIGRATIONS,
      WEB_DIST: tmpWebDist,
      TRUSTED_PROXY_HOPS: '1',
      CREDENTIAL_KEY: CREDENTIAL_KEY_B64,
    });
    const tightApp = createHttpApp({
      config: tightConfig,
      runtime,
      store,
      authenticate: createAuthenticator(tightConfig, createDb(appPool!)),
      pool: appPool!,
      broker,
      aiEnabled: false,
      billing: { entitlements: async () => ['full'] },
      roadmapLimits: {
        views: new RateLimiter({ perMinute: 1 }),
      },
    });
    expect((await getBoard(tightApp, orgSlug, 'portal', { ip: '198.51.100.99' })).status).toBe(200);
    const rlView = await getBoard(tightApp, orgSlug, 'portal', { ip: '198.51.100.99' });
    expect(rlView.status).toBe(429);
    assertPublicHeaders(rlView);
    expect(Number(rlView.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
  });

  it('refuses private (#2604) and template projects, cleans expired OTPs while Projects is off, and supports PDPL erase + org purge', async () => {
    // Template project cannot be linked to a roadmap board.
    const tplProj = await runtime.execute<{ templateId: string }>(
      'projects.template.create',
      { name: 'Mau du an', tasks: [{ title: 'Cong viec mau' }] },
      { actor: asOwner(), orgId },
    );
    await expect(
      runtime.execute(
        'projects.roadmap.board.create',
        { title: 'Tpl Board', projectId: tplProj.templateId },
        { actor: asOwner(), orgId, idempotencyKey: randomUUID() },
      ),
    ).rejects.toMatchObject({ status: 422, code: 'ROADMAP_TEMPLATE_PROJECT_FORBIDDEN' });

    // Forward-compatibility with #2604 (visibility column on ludy_projects.project):
    await admin(async (c) => {
      await c.query(`ALTER TABLE ludy_projects.project ADD COLUMN IF NOT EXISTS visibility text NOT NULL DEFAULT 'public'`);
    });
    const privProj = await runtime.execute<{ projectId: string }>(
      'projects.project.create',
      { name: 'Du an noi bo bi mat' },
      { actor: asOwner(), orgId },
    );
    await admin(async (c) => {
      await c.query(`UPDATE ludy_projects.project SET visibility = 'private' WHERE id = $1`, [privProj.projectId]);
    });
    await expect(
      runtime.execute(
        'projects.roadmap.board.create',
        { title: 'Priv Board', projectId: privProj.projectId },
        { actor: asOwner(), orgId, idempotencyKey: randomUUID() },
      ),
    ).rejects.toMatchObject({ status: 422, code: 'ROADMAP_PRIVATE_PROJECT_FORBIDDEN' });

    // Even turning a public project private AFTER linking a board is blocked by DB trigger project_roadmap_privacy_guard_tr.
    const linkedPublicProj = await runtime.execute<{ projectId: string }>(
      'projects.project.create',
      { name: 'Du an cong khai dang mo' },
      { actor: asOwner(), orgId },
    );
    await runtime.execute(
      'projects.roadmap.board.create',
      { title: 'Privacy Trigger Test', slug: 'priv-guard', enabled: true, projectId: linkedPublicProj.projectId },
      { actor: asOwner(), orgId, idempotencyKey: randomUUID() },
    );
    await expect(
      admin(async (c) => {
        await c.query(`UPDATE ludy_projects.project SET visibility = 'private' WHERE id = $1`, [linkedPublicProj.projectId]);
      }),
    ).rejects.toThrow(/ROADMAP_PRIVATE_PROJECT_FORBIDDEN/);

    // PDPL lookup + erase handles roadmap_otp & roadmap_subscriber machinery cleanly.
    const pdplEmail = 'pdpl-voter@example.test';
    const pdplMails: OutboundMail[] = [];
    const pdplMailer: MailProvider = {
      name: 'test_smtp',
      enabled: true,
      sendRetrySafety: 'idempotent',
      async send(mail) {
        pdplMails.push(mail);
        return { status: 'accepted', providerMessageId: randomUUID() };
      },
      parseWebhook: () => [],
    };
    const pdplOtpReq = await postJson(
      app,
      `/api/projects/public-roadmap/${orgSlug}/main/otp/request`,
      { email: pdplEmail },
      { ip: '198.51.100.70' },
    );
    expect(pdplOtpReq.status).toBe(200);
    await admin(async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `SELECT id FROM ludy_kernel.mail_message WHERE org_id = $1 AND status = 'queued' ORDER BY created_at DESC LIMIT 1`,
        [orgId],
      );
      for (const r of rows) {
        await runMailJob(
          {
            workerDb,
            runtime: workerRuntime,
            mailer: pdplMailer,
            templates: MAIL_TEMPLATES,
            store,
            publicUrl: 'http://localhost:8080',
            bounceDomain: DEFAULT_MESSAGE_ID_DOMAIN,
          },
          { orgId, messageId: r.id },
        );
      }
    });
    const pdplCode = extractSixDigitCode(pdplMails[0]!.text);
    const pdplVerify = await postJson(
      app,
      `/api/projects/public-roadmap/${orgSlug}/main/otp/verify`,
      { email: pdplEmail, code: pdplCode },
      { ip: '198.51.100.70' },
    );
    const { voterToken: pdplVoterToken } = (await pdplVerify.json()) as { voterToken: string };
    const mainBoardId = (
      await runtime.query<{ boards: Array<{ id: string; slug: string }> }>('projects.roadmap.boards', {}, { actor: asOwner(), orgId })
    ).boards.find((b) => b.slug === 'main')!.id;
    const pdplItem = await runtime.execute<{ item: { id: string } }>(
      'projects.roadmap.item.create',
      {
        boardId: mainBoardId,
        publicTitle: `PDPL Test from ${pdplEmail}`,
        moderationStatus: 'published',
      },
      { actor: asOwner(), orgId, idempotencyKey: randomUUID() },
    );
    const pdplVote = await postJson(
      app,
      `/api/projects/public-roadmap/${orgSlug}/main/votes`,
      { itemId: pdplItem.item.id, action: 'vote', notifyOnShip: true },
      { ip: '198.51.100.70', voterToken: pdplVoterToken },
    );
    expect(pdplVote.status).toBe(200);

    const found = await runtime.execute<{ matches: Array<{ column: string }> }>(
      'kernel.personal_data.find',
      { value: pdplEmail },
      { actor: asOwner(), orgId },
    );
    expect(found.matches.some((m) => m.column === 'ludy_projects.roadmap_item.public_title')).toBe(true);

    const erased = await runtime.execute<{ erased: Array<{ column: string; rows: number }> }>(
      'kernel.personal_data.erase',
      { value: pdplEmail },
      { actor: asOwnerMfa(), orgId, idempotencyKey: randomUUID() },
    );
    expect(erased.erased.some((e) => e.column === 'ludy_projects.roadmap_otp.email' && e.rows >= 1)).toBe(true);
    expect(erased.erased.some((e) => e.column === 'ludy_projects.roadmap_subscriber.email_sealed' && e.rows >= 1)).toBe(true);
    expect(erased.erased.some((e) => e.column === 'ludy_projects.roadmap_item.public_title' && e.rows >= 1)).toBe(true);
    await admin(async (c) => {
      const { rows } = await c.query<{ o: string; s: string }>(
        `SELECT
           (SELECT count(*) FROM ludy_projects.roadmap_otp WHERE org_id = $1 AND email = $2)::text AS o,
           (SELECT count(*) FROM ludy_projects.roadmap_subscriber WHERE org_id = $1 AND voter_email_hash = ludy_projects.roadmap_keyed_email_hash($1, $2))::text AS s`,
        [orgId, pdplEmail],
      );
      expect(rows[0]).toEqual({ o: '0', s: '0' });
    });

    // Nightly keeping sweep cleans expired OTPs (> 24h old) even while org_app_on('projects') = false!
    await postJson(
      app,
      `/api/projects/public-roadmap/${orgSlug}/main/otp/request`,
      { email: 'stale-otp@example.test' },
      { ip: '198.51.100.71' },
    );
    await admin(async (c) => {
      await c.query(
        `UPDATE ludy_projects.roadmap_otp SET expires_at = now() - interval '30 hours', invalidated_at = now() - interval '30 hours' WHERE org_id = $1 AND email = 'stale-otp@example.test'`,
        [orgId],
      );
    });
    await runtime.execute('kernel.org.set_app', { module: 'projects', enabled: false }, { actor: asOwner(), orgId });
    try {
      const swept = await sweepRoadmapOtpCleanup({ workerDb, runtime: workerRuntime });
      expect(swept.deleted).toBeGreaterThanOrEqual(1);
    } finally {
      await runtime.execute('kernel.org.set_app', { module: 'projects', enabled: true }, { actor: asOwner(), orgId });
    }

    // org_purge in secondary org with active roadmap data leaves zero roadmap rows behind.
    const purgeBoard = await runtime.execute<{ board: { id: string; slug: string } }>(
      'projects.roadmap.board.create',
      { title: 'Purge Board', enabled: true },
      { actor: asOwner(), orgId: otherOrgId, idempotencyKey: randomUUID() },
    );
    await runtime.execute(
      'projects.roadmap.item.create',
      { boardId: purgeBoard.board.id, publicTitle: 'Item to purge' },
      { actor: asOwner(), orgId: otherOrgId, idempotencyKey: randomUUID() },
    );
    const otherOrgSlug = await admin(async (c) => {
      const { rows } = await c.query<{ slug: string }>(`SELECT slug FROM ludy_kernel.tenant WHERE org_id = $1`, [otherOrgId]);
      return rows[0]!.slug;
    });
    const purgeOtpRes = await postJson(
      app,
      `/api/projects/public-roadmap/${otherOrgSlug}/${purgeBoard.board.slug}/otp/request`,
      { email: 'purge@example.test' },
      { ip: '198.51.100.72' },
    );
    expect(purgeOtpRes.status).toBe(200);
    await admin(async (c) => {
      const dayMs = 24 * 60 * 60 * 1000;
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query(`UPDATE ludy_kernel.tenant SET status = 'offboarding' WHERE org_id = $1`, [otherOrgId]);
      await c.query('COMMIT');
      await c.query(
        `INSERT INTO ludy_kernel.audit_event (org_id, occurred_at, actor_type, actor_id, command, command_id, outcome, input_sha256, detail)
         VALUES ($1, $2, 'user', $3, 'kernel.org.offboard', $4, 'ok', $5, '{}'),
                ($1, $6, 'system', NULL, 'kernel.org.export.record', $7, 'ok', $5, '{"format":"crove.org-export.v2","file_count":0}')`,
        [
          otherOrgId,
          new Date(Date.now() - 40 * dayMs),
          ownerUserId,
          randomUUID(),
          '0'.repeat(64),
          new Date(Date.now() - 31 * dayMs),
          randomUUID(),
        ],
      );
    });
    const purgeCode = await runOrgPurge(
      { runtime: workerRuntime, minDays: 30, log: () => undefined, error: () => undefined },
      [otherOrgSlug, '--reason', 'roadmap test purge'],
    );
    expect(purgeCode).toBe(0);
    await admin(async (c) => {
      const { rows } = await c.query<{ b: string; i: string; o: string; v: string; s: string }>(
        `SELECT
           (SELECT count(*) FROM ludy_projects.roadmap_board WHERE org_id = $1)::text AS b,
           (SELECT count(*) FROM ludy_projects.roadmap_item WHERE org_id = $1)::text AS i,
           (SELECT count(*) FROM ludy_projects.roadmap_otp WHERE org_id = $1)::text AS o,
           (SELECT count(*) FROM ludy_projects.roadmap_vote WHERE org_id = $1)::text AS v,
           (SELECT count(*) FROM ludy_projects.roadmap_subscriber WHERE org_id = $1)::text AS s`,
        [otherOrgId],
      );
      expect(rows[0]).toEqual({ b: '0', i: '0', o: '0', v: '0', s: '0' });
    });
  });
});

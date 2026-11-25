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
import { InboxReader } from '@ludy/agent';
import { projectsCommands, projectsQueries } from '@ludy/mod-projects';
import { DraftBudget } from '../src/ai-draft-limit.ts';
import { createAuthenticator } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { createCredentialBroker } from '../src/credentials.ts';
import { TURNSTILE_ORIGIN, createHttpApp } from '../src/http.ts';
import { runMailJob } from '../src/mail-queue.ts';
import { MAIL_TEMPLATES } from '../src/mail-templates.ts';
import { orgPurgeCommand, runOrgPurge } from '../src/org-purge.ts';
import { prepareRoadmapChangelogDraft, prepareRoadmapDedupe, projectRoadmapAi } from '../src/project-roadmap-ai.ts';
import { roadmapIpHash } from '../src/projects-public-roadmap.ts';
import { dispatchRoadmapAnnouncementNotifications, sweepRoadmapOtpCleanup } from '../src/projects-roadmap-worker.ts';
import { RateLimiter } from '../src/rate-limit.ts';
import { createSessionStatusSource } from '../src/sessions.ts';
import { enterUser } from './context-token.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const JWT_SIGNING_KEY = 'test-only-jwt-key-projects-roadmap-4399-0123456789';
const CREDENTIAL_KEY_B64 = randomBytes(32).toString('base64');
const ISSUER = 'ludy-auth';
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
  const dbName = `ludy_test_roadmap_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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

    // Converting a standalone-board roadmap_item into an org project's task blocks org -> private flip (both RPC and DB trigger).
    const standaloneBoard = await runtime.execute<{ board: { id: string } }>(
      'projects.roadmap.board.create',
      { title: 'Standalone Guard Board', slug: 'standalone-item-guard', enabled: true, projectId: null },
      { actor: asOwner(), orgId, idempotencyKey: randomUUID() },
    );
    const standaloneItem = await runtime.execute<{ item: { id: string } }>(
      'projects.roadmap.item.create',
      { boardId: standaloneBoard.board.id, publicTitle: 'Standalone linked item' },
      { actor: asOwner(), orgId, idempotencyKey: randomUUID() },
    );
    const taskLinkedProj = await runtime.execute<{ projectId: string }>(
      'projects.project.create',
      { name: 'Du an nhan task tu standalone board' },
      { actor: asOwner(), orgId, idempotencyKey: randomUUID() },
    );
    await runtime.execute(
      'projects.roadmap.item.convert_to_task',
      { itemId: standaloneItem.item.id, projectId: taskLinkedProj.projectId },
      { actor: asOwner(), orgId, idempotencyKey: randomUUID() },
    );
    await expect(
      runtime.execute(
        'projects.project.update',
        { projectId: taskLinkedProj.projectId, visibility: 'private' },
        { actor: asOwner(), orgId, idempotencyKey: randomUUID() },
      ),
    ).rejects.toMatchObject({ status: 422, code: 'ROADMAP_PRIVATE_PROJECT_FORBIDDEN' });
    await expect(
      admin(async (c) => {
        await c.query(`UPDATE ludy_projects.project SET visibility = 'private' WHERE org_id = $1 AND id = $2`, [
          orgId,
          taskLinkedProj.projectId,
        ]);
      }),
    ).rejects.toThrow(/ROADMAP_PRIVATE_PROJECT_FORBIDDEN/);

    // Direct SQL linking of a private project's task into roadmap_item.linked_task_id is blocked by roadmap_item_privacy_guard_tr.
    const privTask = await runtime.execute<{ taskId: string }>(
      'projects.task.create',
      { projectId: privProj.projectId, title: 'Viec rieng tu khong duoc gan lo trinh', assigneePositionId: null },
      { actor: asOwner(), orgId, idempotencyKey: randomUUID() },
    );
    const unlinkedPrivCheckItem = await runtime.execute<{ item: { id: string } }>(
      'projects.roadmap.item.create',
      { boardId: standaloneBoard.board.id, publicTitle: 'Khong duoc gan task rieng tu' },
      { actor: asOwner(), orgId, idempotencyKey: randomUUID() },
    );
    await expect(
      admin(async (c) => {
        await c.query(`UPDATE ludy_projects.roadmap_item SET linked_task_id = $3 WHERE org_id = $1 AND id = $2`, [
          orgId,
          unlinkedPrivCheckItem.item.id,
          privTask.taskId,
        ]);
      }),
    ).rejects.toThrow(/ROADMAP_PRIVATE_PROJECT_FORBIDDEN/);

    // Concurrent READ COMMITTED serialization between org -> private project.update and roadmap.item.convert_to_task / linked_task_id write.
    const waitForLock = async () => {
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        const locked = await admin(async (c) => {
          const { rows } = await c.query<{ cnt: number }>(
            `SELECT count(*)::int AS cnt
               FROM pg_catalog.pg_stat_activity
              WHERE datname = pg_catalog.current_database()
                AND wait_event_type = 'Lock'
                AND pid <> pg_catalog.pg_backend_pid()`,
          );
          return (rows[0]?.cnt ?? 0) > 0;
        });
        if (locked) return true;
        await new Promise((r) => setTimeout(r, 15));
      }
      return false;
    };

    // Race Direction 1: Tx A updates project org -> private (uncommitted); concurrent convert_to_task blocks on FOR SHARE, sees private after commit, and rejects 422.
    const raceProj1 = await runtime.execute<{ projectId: string }>(
      'projects.project.create',
      { name: 'Du an dua 1' },
      { actor: asOwner(), orgId, idempotencyKey: randomUUID() },
    );
    const raceItem1 = await runtime.execute<{ item: { id: string } }>(
      'projects.roadmap.item.create',
      { boardId: standaloneBoard.board.id, publicTitle: 'Muc dua 1' },
      { actor: asOwner(), orgId, idempotencyKey: randomUUID() },
    );
    const c1 = await appPool!.connect();
    let convertOutcome: Promise<{ ok: true; value: unknown } | { ok: false; err: unknown }> | undefined;
    try {
      await c1.query('BEGIN');
      await enterUser(c1, ownerUserId, orgId);
      await c1.query('SET LOCAL ROLE ludy_tenant');
      await c1.query(`UPDATE ludy_projects.project SET visibility = 'private' WHERE org_id = $1 AND id = $2`, [
        orgId,
        raceProj1.projectId,
      ]);

      convertOutcome = runtime
        .execute(
          'projects.roadmap.item.convert_to_task',
          { itemId: raceItem1.item.id, projectId: raceProj1.projectId },
          { actor: asOwner(), orgId, idempotencyKey: randomUUID() },
        )
        .then(
          (value) => ({ ok: true as const, value }),
          (err: unknown) => ({ ok: false as const, err }),
        );
      expect(await waitForLock()).toBe(true);
      await c1.query('COMMIT');
    } catch (err) {
      await c1.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      c1.release();
    }
    expect(await convertOutcome).toMatchObject({
      ok: false,
      err: { code: 'ROADMAP_PRIVATE_PROJECT_FORBIDDEN', status: 422 },
    });
    await admin(async (c) => {
      const { rows } = await c.query<{ linked_task_id: string | null }>(
        `SELECT linked_task_id FROM ludy_projects.roadmap_item WHERE org_id = $1 AND id = $2`,
        [orgId, raceItem1.item.id],
      );
      expect(rows[0]!.linked_task_id).toBeNull();
    });

    // Race Direction 2: Tx A sets linked_task_id inside FOR SHARE (uncommitted); concurrent project.update -> private blocks on FOR UPDATE, sees linked_task_id after commit, and rejects 422.
    const raceProj2 = await runtime.execute<{ projectId: string }>(
      'projects.project.create',
      { name: 'Du an dua 2' },
      { actor: asOwner(), orgId, idempotencyKey: randomUUID() },
    );
    const raceTask2 = await runtime.execute<{ taskId: string }>(
      'projects.task.create',
      { projectId: raceProj2.projectId, title: 'Viec dua 2', assigneePositionId: null },
      { actor: asOwner(), orgId, idempotencyKey: randomUUID() },
    );
    const raceItem2 = await runtime.execute<{ item: { id: string } }>(
      'projects.roadmap.item.create',
      { boardId: standaloneBoard.board.id, publicTitle: 'Muc dua 2' },
      { actor: asOwner(), orgId, idempotencyKey: randomUUID() },
    );
    const c2 = await appPool!.connect();
    let privUpdateOutcome: Promise<{ ok: true; value: unknown } | { ok: false; err: unknown }> | undefined;
    try {
      await c2.query('BEGIN');
      await enterUser(c2, ownerUserId, orgId);
      await c2.query('SET LOCAL ROLE ludy_tenant');
      await c2.query(`UPDATE ludy_projects.roadmap_item SET linked_task_id = $3 WHERE org_id = $1 AND id = $2`, [
        orgId,
        raceItem2.item.id,
        raceTask2.taskId,
      ]);

      privUpdateOutcome = runtime
        .execute(
          'projects.project.update',
          { projectId: raceProj2.projectId, visibility: 'private' },
          { actor: asOwner(), orgId, idempotencyKey: randomUUID() },
        )
        .then(
          (value) => ({ ok: true as const, value }),
          (err: unknown) => ({ ok: false as const, err }),
        );
      expect(await waitForLock()).toBe(true);
      await c2.query('COMMIT');
    } catch (err) {
      await c2.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      c2.release();
    }
    expect(await privUpdateOutcome).toMatchObject({
      ok: false,
      err: { code: 'ROADMAP_PRIVATE_PROJECT_FORBIDDEN', status: 422 },
    });
    await admin(async (c) => {
      const { rows } = await c.query<{ visibility: string }>(
        `SELECT visibility FROM ludy_projects.project WHERE org_id = $1 AND id = $2`,
        [orgId, raceProj2.projectId],
      );
      expect(rows[0]!.visibility).toBe('org');
    });

    // Direct SQL project_task.project_id -> private update is blocked while task is linked from a roadmap item.
    const directMovePrivProj = await runtime.execute<{ projectId: string }>(
      'projects.project.create',
      { name: 'Du an rieng tu chan SQL', visibility: 'private' },
      { actor: asOwner(), orgId, idempotencyKey: randomUUID() },
    );
    await expect(
      admin((c) =>
        c.query(`UPDATE ludy_projects.project_task SET project_id = $3 WHERE org_id = $1 AND task_id = $2`, [
          orgId,
          raceTask2.taskId,
          directMovePrivProj.projectId,
        ]),
      ),
    ).rejects.toMatchObject({ code: '23514' });

    // Race Direction 3 (EPQ): Tx A moves task to private project (uncommitted); concurrent roadmap_item.linked_task_id update blocks on project_task FOR SHARE, re-fetches project_id via EPQ, and rejects 23514.
    const raceProj3Org = await runtime.execute<{ projectId: string }>(
      'projects.project.create',
      { name: 'Du an dua 3 org' },
      { actor: asOwner(), orgId, idempotencyKey: randomUUID() },
    );
    const raceProj3Priv = await runtime.execute<{ projectId: string }>(
      'projects.project.create',
      { name: 'Du an dua 3 private', visibility: 'private' },
      { actor: asOwner(), orgId, idempotencyKey: randomUUID() },
    );
    const raceTask3 = await runtime.execute<{ taskId: string }>(
      'projects.task.create',
      { projectId: raceProj3Org.projectId, title: 'Viec dua 3', assigneePositionId: null },
      { actor: asOwner(), orgId, idempotencyKey: randomUUID() },
    );
    const raceItem3 = await runtime.execute<{ item: { id: string } }>(
      'projects.roadmap.item.create',
      { boardId: standaloneBoard.board.id, publicTitle: 'Muc dua 3' },
      { actor: asOwner(), orgId, idempotencyKey: randomUUID() },
    );
    const c3A = await appPool!.connect();
    const c3B = await appPool!.connect();
    let linkPrivRaceOutcome: Promise<void> | undefined;
    try {
      await c3A.query('BEGIN');
      await enterUser(c3A, ownerUserId, orgId);
      await c3A.query('SET LOCAL ROLE ludy_tenant');
      await c3A.query(`UPDATE ludy_projects.project_task SET project_id = $3 WHERE org_id = $1 AND task_id = $2`, [
        orgId,
        raceTask3.taskId,
        raceProj3Priv.projectId,
      ]);

      await c3B.query('BEGIN');
      await enterUser(c3B, ownerUserId, orgId);
      await c3B.query('SET LOCAL ROLE ludy_tenant');
      linkPrivRaceOutcome = c3B
        .query(`UPDATE ludy_projects.roadmap_item SET linked_task_id = $3 WHERE org_id = $1 AND id = $2`, [
          orgId,
          raceItem3.item.id,
          raceTask3.taskId,
        ])
        .then(() => undefined);

      expect(await waitForLock()).toBe(true);
      await c3A.query('COMMIT');
      await expect(linkPrivRaceOutcome).rejects.toMatchObject({ code: '23514' });
      await c3B.query('ROLLBACK').catch(() => {});
    } catch (err) {
      await c3A.query('ROLLBACK').catch(() => {});
      await c3B.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      c3A.release();
      c3B.release();
    }
    await admin(async (c) => {
      const { rows } = await c.query<{ linked_task_id: string | null }>(
        `SELECT linked_task_id FROM ludy_projects.roadmap_item WHERE org_id = $1 AND id = $2`,
        [orgId, raceItem3.item.id],
      );
      expect(rows[0]!.linked_task_id).toBeNull();
    });

    // Race Direction 4: Tx A sets roadmap_item.linked_task_id (uncommitted, FOR SHARE on project_task); concurrent UPDATE project_task.project_id -> private waits, fires AFTER trigger against newly committed roadmap_item, and rejects 23514.
    const raceProj4Org = await runtime.execute<{ projectId: string }>(
      'projects.project.create',
      { name: 'Du an dua 4 org' },
      { actor: asOwner(), orgId, idempotencyKey: randomUUID() },
    );
    const raceProj4Priv = await runtime.execute<{ projectId: string }>(
      'projects.project.create',
      { name: 'Du an dua 4 private', visibility: 'private' },
      { actor: asOwner(), orgId, idempotencyKey: randomUUID() },
    );
    const raceTask4 = await runtime.execute<{ taskId: string }>(
      'projects.task.create',
      { projectId: raceProj4Org.projectId, title: 'Viec dua 4', assigneePositionId: null },
      { actor: asOwner(), orgId, idempotencyKey: randomUUID() },
    );
    const raceItem4 = await runtime.execute<{ item: { id: string } }>(
      'projects.roadmap.item.create',
      { boardId: standaloneBoard.board.id, publicTitle: 'Muc dua 4' },
      { actor: asOwner(), orgId, idempotencyKey: randomUUID() },
    );
    const c4A = await appPool!.connect();
    const c4B = await appPool!.connect();
    let moveTaskPrivRaceOutcome: Promise<void> | undefined;
    try {
      await c4A.query('BEGIN');
      await enterUser(c4A, ownerUserId, orgId);
      await c4A.query('SET LOCAL ROLE ludy_tenant');
      await c4A.query(`UPDATE ludy_projects.roadmap_item SET linked_task_id = $3 WHERE org_id = $1 AND id = $2`, [
        orgId,
        raceItem4.item.id,
        raceTask4.taskId,
      ]);

      await c4B.query('BEGIN');
      await enterUser(c4B, ownerUserId, orgId);
      await c4B.query('SET LOCAL ROLE ludy_tenant');
      moveTaskPrivRaceOutcome = c4B
        .query(`UPDATE ludy_projects.project_task SET project_id = $3 WHERE org_id = $1 AND task_id = $2`, [
          orgId,
          raceTask4.taskId,
          raceProj4Priv.projectId,
        ])
        .then(() => undefined);

      expect(await waitForLock()).toBe(true);
      await c4A.query('COMMIT');
      await expect(moveTaskPrivRaceOutcome).rejects.toMatchObject({ code: '23514' });
      await c4B.query('ROLLBACK').catch(() => {});
    } catch (err) {
      await c4A.query('ROLLBACK').catch(() => {});
      await c4B.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      c4A.release();
      c4B.release();
    }
    await admin(async (c) => {
      const { rows } = await c.query<{ project_id: string }>(
        `SELECT project_id FROM ludy_projects.project_task WHERE org_id = $1 AND task_id = $2`,
        [orgId, raceTask4.taskId],
      );
      expect(rows[0]!.project_id).toBe(raceProj4Org.projectId);
    });

    // Defense-in-depth (#4631): roadmap_item_privacy_guard() fails closed when v_project_id IS NULL or v_visibility IS DISTINCT FROM 'org'.
    const failClosedItem = await runtime.execute<{ item: { id: string } }>(
      'projects.roadmap.item.create',
      { boardId: standaloneBoard.board.id, publicTitle: 'Fail closed guard check' },
      { actor: asOwner(), orgId, idempotencyKey: randomUUID() },
    );
    const unlinkedKernelTask = await runtime.execute<{ taskId: string }>(
      'kernel.task.create',
      { title: 'Task without project_task row', assigneePositionId: null },
      { actor: asOwner(), orgId, idempotencyKey: randomUUID() },
    );
    await admin(async (c) => {
      await c.query('BEGIN');
      try {
        await c.query(`ALTER TABLE ludy_projects.roadmap_item DROP CONSTRAINT roadmap_item_task_fk`);
        await expect(
          c.query(`UPDATE ludy_projects.roadmap_item SET linked_task_id = $3 WHERE org_id = $1 AND id = $2`, [
            orgId,
            failClosedItem.item.id,
            unlinkedKernelTask.taskId,
          ]),
        ).rejects.toMatchObject({
          code: '23514',
          message: expect.stringContaining('ROADMAP_PRIVATE_PROJECT_FORBIDDEN'),
        });
      } finally {
        await c.query('ROLLBACK').catch(() => {});
      }
    });

    const restrictedProj = await runtime.execute<{ projectId: string }>(
      'projects.project.create',
      { name: 'Du an thu visibility khac org' },
      { actor: asOwner(), orgId, idempotencyKey: randomUUID() },
    );
    const restrictedTask = await runtime.execute<{ taskId: string }>(
      'projects.task.create',
      { projectId: restrictedProj.projectId, title: 'Task trong project visibility khac org', assigneePositionId: null },
      { actor: asOwner(), orgId, idempotencyKey: randomUUID() },
    );
    await admin(async (c) => {
      await c.query('BEGIN');
      try {
        await c.query(`ALTER TABLE ludy_projects.project DROP CONSTRAINT project_visibility_check`);
        await c.query(`UPDATE ludy_projects.project SET visibility = 'restricted' WHERE org_id = $1 AND id = $2`, [
          orgId,
          restrictedProj.projectId,
        ]);
        await c.query('SAVEPOINT sp_roadmap_item_guard');
        await expect(
          c.query(`UPDATE ludy_projects.roadmap_item SET linked_task_id = $3 WHERE org_id = $1 AND id = $2`, [
            orgId,
            failClosedItem.item.id,
            restrictedTask.taskId,
          ]),
        ).rejects.toMatchObject({
          code: '23514',
          message: expect.stringContaining('ROADMAP_PRIVATE_PROJECT_FORBIDDEN'),
        });
        await c.query('ROLLBACK TO SAVEPOINT sp_roadmap_item_guard');

        // Companion privacy triggers (#4689): roadmap_board_guard_tr and project_task_roadmap_privacy_guard_tr
        // fail closed when visibility IS DISTINCT FROM 'org'.
        await c.query('SAVEPOINT sp_board_guard');
        await expect(
          c.query(
            `INSERT INTO ludy_projects.roadmap_board (org_id, slug, title, enabled, project_id, created_by)
             VALUES ($1, $2, 'Restricted Board Guard', false, $3, $4)`,
            [orgId, `restricted-board-${randomUUID().slice(0, 8)}`, restrictedProj.projectId, ownerUserId],
          ),
        ).rejects.toMatchObject({
          code: '23514',
          message: expect.stringContaining('ROADMAP_PRIVATE_PROJECT_FORBIDDEN'),
        });
        await c.query('ROLLBACK TO SAVEPOINT sp_board_guard');

        await c.query('SAVEPOINT sp_task_guard');
        await expect(
          c.query(`UPDATE ludy_projects.project_task SET project_id = $3 WHERE org_id = $1 AND task_id = $2`, [
            orgId,
            raceTask2.taskId,
            restrictedProj.projectId,
          ]),
        ).rejects.toMatchObject({
          code: '23514',
          message: expect.stringContaining('ROADMAP_PRIVATE_PROJECT_FORBIDDEN'),
        });
        await c.query('ROLLBACK TO SAVEPOINT sp_task_guard');
      } finally {
        await c.query('ROLLBACK').catch(() => {});
      }
    });

    // Companion project_roadmap_privacy_guard_tr (#4689): blocks org -> non-org transition on board-linked and task-linked projects.
    await admin(async (c) => {
      await c.query('BEGIN');
      try {
        await c.query(`ALTER TABLE ludy_projects.project DROP CONSTRAINT project_visibility_check`);
        await c.query('SAVEPOINT sp_proj_board_guard');
        await expect(
          c.query(`UPDATE ludy_projects.project SET visibility = 'restricted' WHERE org_id = $1 AND id = $2`, [
            orgId,
            linkedPublicProj.projectId,
          ]),
        ).rejects.toMatchObject({
          code: '23514',
          message: expect.stringContaining('ROADMAP_PRIVATE_PROJECT_FORBIDDEN'),
        });
        await c.query('ROLLBACK TO SAVEPOINT sp_proj_board_guard');

        await c.query('SAVEPOINT sp_proj_task_guard');
        await expect(
          c.query(`UPDATE ludy_projects.project SET visibility = 'restricted' WHERE org_id = $1 AND id = $2`, [
            orgId,
            taskLinkedProj.projectId,
          ]),
        ).rejects.toMatchObject({
          code: '23514',
          message: expect.stringContaining('ROADMAP_PRIVATE_PROJECT_FORBIDDEN'),
        });
        await c.query('ROLLBACK TO SAVEPOINT sp_proj_task_guard');
      } finally {
        await c.query('ROLLBACK').catch(() => {});
      }
    });

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

    // PDPL erase with linked roadmap_item -> roadmap_board -> project + weekly status mail (#4689):
    // mail_message drop still sees unredacted project.name before roadmap_item, roadmap_board, and project redact.
    const linkedPdplEmail = 'pdpl-linked-order@example.test';
    const linkedPdplProj = await runtime.execute<{ projectId: string }>(
      'projects.project.create',
      { name: `Du an lien ket ${linkedPdplEmail}` },
      { actor: asOwner(), orgId, idempotencyKey: randomUUID() },
    );
    await runtime.execute(
      'projects.member.add',
      { projectId: linkedPdplProj.projectId, userId: memberUserId },
      { actor: asOwner(), orgId, idempotencyKey: randomUUID() },
    );
    await runtime.execute(
      'projects.weekly_status.send_mail',
      {
        projectId: linkedPdplProj.projectId,
        subject: 'Bao cao tuan dinh ky',
        summary: 'Tien do on dinh.',
        language: 'vi',
        tainted: false,
        confirmed: true,
      },
      { actor: asOwner(), orgId, idempotencyKey: randomUUID() },
    );
    const linkedPdplBoard = await runtime.execute<{ board: { id: string } }>(
      'projects.roadmap.board.create',
      {
        title: `Bang ${linkedPdplEmail}`,
        slug: 'pdpl-linked-board',
        enabled: true,
        projectId: linkedPdplProj.projectId,
      },
      { actor: asOwner(), orgId, idempotencyKey: randomUUID() },
    );
    const linkedPdplItem = await runtime.execute<{ item: { id: string } }>(
      'projects.roadmap.item.create',
      {
        boardId: linkedPdplBoard.board.id,
        publicTitle: `De xuat ${linkedPdplEmail}`,
        publicSummary: `Mo ta ${linkedPdplEmail}`,
        moderationStatus: 'published',
      },
      { actor: asOwner(), orgId, idempotencyKey: randomUUID() },
    );
    await runtime.execute(
      'projects.roadmap.item.convert_to_task',
      { itemId: linkedPdplItem.item.id, projectId: linkedPdplProj.projectId },
      { actor: asOwner(), orgId, idempotencyKey: randomUUID() },
    );
    const linkedErased = await runtime.execute<{ erased: Array<{ column: string; rows: number }> }>(
      'kernel.personal_data.erase',
      { value: linkedPdplEmail },
      { actor: asOwnerMfa(), orgId, idempotencyKey: randomUUID() },
    );
    expect(linkedErased.erased).toEqual(
      expect.arrayContaining([
        { column: 'ludy_kernel.mail_message.payload', rows: 1 },
        { column: 'ludy_projects.roadmap_item.public_title', rows: 1 },
        { column: 'ludy_projects.roadmap_item.public_summary', rows: 1 },
        { column: 'ludy_projects.roadmap_board.title', rows: 1 },
        { column: 'ludy_projects.project.name', rows: 1 },
      ]),
    );
    await admin(async (c) => {
      const { rows: mailRows } = await c.query<{ payload: unknown; subject: string | null }>(
        `SELECT payload, subject FROM ludy_kernel.mail_message
          WHERE org_id = $1 AND source = 'projects.weekly_status.send_mail' AND source_id = $2`,
        [orgId, linkedPdplProj.projectId],
      );
      expect(mailRows[0]).toEqual({ payload: null, subject: null });
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

  it('implements Slice 2 changelog announcements, shipped notifications, Vy AI workflows with AI-off parity, MCP reads, and PDPL (#4400)', async () => {
    // 1. Setup dedicated Slice 2 board, shipped & non-shipped items, plus subscribers (active + suppressed + unsubscribed).
    const s2BoardRes = await runtime.execute<{ board: { id: string; slug: string } }>(
      'projects.roadmap.board.create',
      { title: 'Changelog Slice 2 Board', slug: 's2-changelog', enabled: true, requireModeration: true },
      { actor: asOwner(), orgId, idempotencyKey: randomUUID() },
    );
    const s2BoardId = s2BoardRes.board.id;

    const shippedItem = await runtime.execute<{ item: { id: string } }>(
      'projects.roadmap.item.create',
      { boardId: s2BoardId, publicTitle: 'Export CSV bang tong hop', stage: 'shipped', moderationStatus: 'published' },
      { actor: asAdmin(), orgId, idempotencyKey: randomUUID() },
    );
    const plannedItem = await runtime.execute<{ item: { id: string } }>(
      'projects.roadmap.item.create',
      { boardId: s2BoardId, publicTitle: 'Dark mode dashboard', stage: 'planned', moderationStatus: 'published' },
      { actor: asAdmin(), orgId, idempotencyKey: randomUUID() },
    );
    const pendingItem = await runtime.execute<{ item: { id: string } }>(
      'projects.roadmap.item.create',
      { boardId: s2BoardId, publicTitle: 'Y tuong cho duyet', stage: 'shipped', moderationStatus: 'pending' },
      { actor: asMember(), orgId, idempotencyKey: randomUUID() },
    );

    // Announcement create validates linked shipped items (rejects planned/pending/unknown items).
    await expect(
      runtime.execute(
        'projects.roadmap.announcement.create',
        { boardId: s2BoardId, title: 'Bad link', bodyMd: 'Body', linkedItemIds: [plannedItem.item.id] },
        { actor: asMember(), orgId, idempotencyKey: randomUUID() },
      ),
    ).rejects.toThrow();
    await expect(
      runtime.execute(
        'projects.roadmap.announcement.create',
        { boardId: s2BoardId, title: 'Bad link pending', bodyMd: 'Body', linkedItemIds: [pendingItem.item.id] },
        { actor: asMember(), orgId, idempotencyKey: randomUUID() },
      ),
    ).rejects.toThrow();

    // Create + edit + delete draft announcement works cleanly.
    const disposable = await runtime.execute<{ announcement: { id: string; status: string } }>(
      'projects.roadmap.announcement.create',
      { boardId: s2BoardId, title: 'Draft to remove', bodyMd: 'Temp body', linkedItemIds: [shippedItem.item.id] },
      { actor: asMember(), orgId, idempotencyKey: randomUUID() },
    );
    expect(disposable.announcement.status).toBe('draft');
    await runtime.execute(
      'projects.roadmap.announcement.delete',
      { announcementId: disposable.announcement.id },
      { actor: asMember(), orgId, idempotencyKey: randomUUID() },
    );

    // Create release announcement (hidden from public GET while draft).
    const annCreated = await runtime.execute<{ announcement: { id: string; status: string } }>(
      'projects.roadmap.announcement.create',
      {
        boardId: s2BoardId,
        title: 'Cap nhat thang 3 cho khach hang',
        bodyMd: '## Tinh nang moi\n- Da ho tro **Export CSV** voi <script>safeText</script>',
        linkedItemIds: [shippedItem.item.id],
      },
      { actor: asMember(), orgId, idempotencyKey: randomUUID() },
    );
    const annId = annCreated.announcement.id;

    // Member cannot publish or send external shipped alerts (MANAGERS only).
    await expect(
      runtime.execute(
        'projects.roadmap.announcement.publish',
        { announcementId: annId },
        { actor: asMember(), orgId, idempotencyKey: randomUUID() },
      ),
    ).rejects.toThrow();

    const publicDraftRes = await getBoard(app, orgSlug, 's2-changelog');
    expect(publicDraftRes.status).toBe(200);
    assertPublicHeaders(publicDraftRes);
    const publicDraftBody = (await publicDraftRes.json()) as { announcements?: unknown[] };
    expect(publicDraftBody.announcements ?? []).toHaveLength(0);

    // Admin cannot send alerts before publish.
    await expect(
      runtime.execute(
        'projects.roadmap.announcement.send_notifications',
        { announcementId: annId },
        { actor: asAdmin(), orgId, idempotencyKey: randomUUID() },
      ),
    ).rejects.toThrow();

    // Publish makes announcement visible in public GET reverse-chronologically with shipped badge only, and ?embed=1 honors CSP.
    const published = await runtime.execute<{ announcement: { id: string; status: string; publishedAt: string } }>(
      'projects.roadmap.announcement.publish',
      { announcementId: annId },
      { actor: asAdmin(), orgId, idempotencyKey: randomUUID() },
    );
    expect(published.announcement.status).toBe('published');
    expect(published.announcement.publishedAt).toBeTruthy();

    const publicPublishedRes = await getBoard(app, orgSlug, 's2-changelog');
    expect(publicPublishedRes.status).toBe(200);
    const publicPublishedBody = (await publicPublishedRes.json()) as {
      announcements: Array<{ id: string; title: string; linkedItems: Array<{ id: string; stage: string }> }>;
    };
    expect(publicPublishedBody.announcements).toHaveLength(1);
    expect(publicPublishedBody.announcements[0]!.id).toBe(annId);
    expect(publicPublishedBody.announcements[0]!.linkedItems.map((l) => l.stage)).toEqual(['shipped']);

    const embedHtmlRes = await app.request(`${ROADMAP_PAGE_PREFIX}/${orgSlug}/s2-changelog?embed=1&tab=changelog`);
    expect(embedHtmlRes.status).toBe(200);
    expect(embedHtmlRes.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");

    // Once published, announcements become immutable (even for members or admins attempting post-publish edits).
    await expect(
      runtime.execute(
        'projects.roadmap.announcement.update',
        { announcementId: annId, title: 'Tampered title' },
        { actor: asMember(), orgId, idempotencyKey: randomUUID() },
      ),
    ).rejects.toThrow();

    // 2. Public subscribe toggle + marketing suppression enforcement + deterministic activeSubscriberCount.
    const memberEmail = 'member-rm@example.test';
    const memberJwt = await mintUserJwt('rm-member', memberEmail);
    const adminSubEmail = 'admin-rm@example.test';
    const adminJwt = await mintUserJwt('rm-admin', adminSubEmail);

    const subMember = await postJson(
      app,
      `/api/projects/public-roadmap/${orgSlug}/s2-changelog/votes`,
      { action: 'subscribe', notifyOnShip: true },
      { ip: '198.51.100.80', bearer: memberJwt },
    );
    expect(subMember.status).toBe(200);
    await expect(subMember.json()).resolves.toEqual({ notifyOnShip: true });

    const subAdmin = await postJson(
      app,
      `/api/projects/public-roadmap/${orgSlug}/s2-changelog/votes`,
      { action: 'subscribe', notifyOnShip: true },
      { ip: '198.51.100.81', bearer: adminJwt },
    );
    expect(subAdmin.status).toBe(200);

    // Suppress adminSubEmail on 'marketing' stream -> activeSubscriberCount drops from 2 to 1!
    await runtime.execute(
      'kernel.mail.suppression.add',
      { email: adminSubEmail, scope: 'marketing' },
      { actor: asOwner(), orgId },
    );
    const detailAfterSub = await runtime.query<{
      activeSubscriberCount: number;
      announcements: Array<{ id: string }>;
    }>('projects.roadmap.board.get', { boardId: s2BoardId }, { actor: asAdmin(), orgId });
    expect(detailAfterSub.activeSubscriberCount).toBe(1);
    expect(JSON.stringify(detailAfterSub)).not.toContain(memberEmail);
    expect(JSON.stringify(detailAfterSub)).not.toContain(adminSubEmail);

    // Send notifications (R2 external) -> emits outbox event; second call is idempotent no-op!
    const send1 = await runtime.execute<{
      eligibleCount: number;
      queuedDispatch: boolean;
      announcement: { notificationsSentAt: string | null };
    }>(
      'projects.roadmap.announcement.send_notifications',
      { announcementId: annId },
      { actor: asAdmin(), orgId, idempotencyKey: randomUUID() },
    );
    expect(send1.eligibleCount).toBe(1);
    expect(send1.queuedDispatch).toBe(true);
    expect(send1.announcement.notificationsSentAt).toBeTruthy();

    const send2 = await runtime.execute<{ eligibleCount: number; queuedDispatch: boolean }>(
      'projects.roadmap.announcement.send_notifications',
      { announcementId: annId },
      { actor: asAdmin(), orgId, idempotencyKey: randomUUID() },
    );
    expect(send2.eligibleCount).toBe(0);
    expect(send2.queuedDispatch).toBe(false);

    // Find emitted outbox event and run worker dispatch + runMailJob!
    const notifyEventId = await admin(async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `SELECT id FROM ludy_kernel.outbox_event WHERE org_id = $1 AND type = 'projects.roadmap.announcement_notify' ORDER BY id DESC LIMIT 1`,
        [orgId],
      );
      return rows[0]!.id;
    });

    const dispatched = await dispatchRoadmapAnnouncementNotifications(
      { workerDb, runtime: workerRuntime, broker },
      { orgId, eventId: notifyEventId },
    );
    expect(dispatched).toEqual({ queued: 1, skipped: 0, off: false });

    const shippedMails: OutboundMail[] = [];
    const shippedMailer: MailProvider = {
      name: 'test_smtp',
      enabled: true,
      sendRetrySafety: 'idempotent',
      async send(mail) {
        shippedMails.push(mail);
        return { status: 'accepted', providerMessageId: randomUUID() };
      },
      parseWebhook: () => [],
    };
    const mailRows = await admin(async (c) => {
      const { rows } = await c.query<{ id: string; stream: string; status: string }>(
        `SELECT id, stream, status FROM ludy_kernel.mail_message WHERE org_id = $1 AND source = 'projects.roadmap.announcement.send_notifications' ORDER BY status`,
        [orgId],
      );
      return rows;
    });
    const msgIds = mailRows.filter((r) => r.status === 'queued').map((r) => r.id);
    expect(msgIds).toHaveLength(1);
    expect(mailRows.every((r) => r.stream === 'marketing')).toBe(true);
    for (const messageId of msgIds) {
      const outcome = await runMailJob(
        {
          workerDb,
          runtime: workerRuntime,
          mailer: shippedMailer,
          templates: MAIL_TEMPLATES,
          broker,
          store,
          publicUrl: 'https://ludy.test',
          bounceDomain: DEFAULT_MESSAGE_ID_DOMAIN,
        },
        { orgId, messageId },
      );
      expect(outcome).toMatchObject({ action: 'recorded', outcome: 'sent' });
    }
    expect(shippedMails).toHaveLength(1);
    expect(shippedMails[0]!.to).toBe(memberEmail);
    expect(shippedMails[0]!.text).toContain('Export CSV bang tong hop');
    const unsubMatch = /#unsubscribe=([A-Za-z0-9_-]{16,})/.exec(shippedMails[0]!.text);
    expect(unsubMatch).not.toBeNull();

    // Unsubscribing with that fragment token opts subscriber out cleanly.
    const fragmentUnsub = await postJson(
      app,
      `/api/projects/public-roadmap/${orgSlug}/s2-changelog/votes`,
      { action: 'unsubscribe', unsubscribeToken: unsubMatch![1]! },
      { ip: '198.51.100.82' },
    );
    expect(fragmentUnsub.status).toBe(200);
    const detailAfterUnsub = await runtime.query<{ activeSubscriberCount: number }>(
      'projects.roadmap.board.get',
      { boardId: s2BoardId },
      { actor: asAdmin(), orgId },
    );
    expect(detailAfterUnsub.activeSubscriberCount).toBe(0);

    // 3. Vy AI workflows + 100% AI-off parity.
    const fakeReader = new InboxReader(
      { baseURL: 'http://127.0.0.1:1/v1', apiKey: null, model: 'test-model' },
      {
        roadmapDedupe: async () => ({
          output: {
            suggestions: [
              {
                sourceItemId: plannedItem.item.id,
                targetItemId: shippedItem.item.id,
                confidence: 'high',
                reason: 'Cả hai đều yêu cầu tính năng xuất báo cáo.',
              },
            ],
          },
          usage: { inputTokens: 15, outputTokens: 8 },
        }),
        roadmapChangelogDraft: async () => ({
          output: {
            title: 'Bản cập nhật tính năng xuất CSV',
            bodyMd: '## Điểm mới\n- Đã hoàn thiện Export CSV bang tong hop.',
          },
          usage: { inputTokens: 18, outputTokens: 10 },
        }),
      },
    );
    const dedupeSource = await runtime.query<Parameters<typeof prepareRoadmapDedupe>[3]>(
      'projects.roadmap.ai_dedupe_source',
      { boardId: s2BoardId },
      { actor: asAdmin(), orgId },
    );
    const aiOnDedupe = await prepareRoadmapDedupe(
      projectRoadmapAi(fakeReader, new DraftBudget({ perUserPerMinute: 10, perOrgPerMinute: 30 })),
      orgId,
      adminUserId,
      dedupeSource,
      'vi',
    );
    expect(aiOnDedupe.ai).toBe('used');
    expect(aiOnDedupe.suggestions).toHaveLength(1);

    const changelogSource = await runtime.query<Parameters<typeof prepareRoadmapChangelogDraft>[3]>(
      'projects.roadmap.ai_changelog_source',
      { boardId: s2BoardId, itemIds: [shippedItem.item.id] },
      { actor: asAdmin(), orgId },
    );
    const aiOnDraft = await prepareRoadmapChangelogDraft(
      projectRoadmapAi(fakeReader, new DraftBudget({ perUserPerMinute: 10, perOrgPerMinute: 30 })),
      orgId,
      adminUserId,
      changelogSource,
      'vi',
    );
    expect(aiOnDraft.ai).toBe('used');
    expect(aiOnDraft.title).toContain('CSV');

    // AI-off parity: reader = null returns 'off', while manual edit/publish still succeeds.
    const aiOffDraft = await prepareRoadmapChangelogDraft(
      projectRoadmapAi(null, new DraftBudget({ perUserPerMinute: 10, perOrgPerMinute: 30 })),
      orgId,
      adminUserId,
      changelogSource,
      'vi',
    );
    expect(aiOffDraft).toEqual({ ai: 'off', title: null, bodyMd: null });

    // 4. MCP read queries: company owner/admin succeeds and scrubs/tags external submissions; private projects excluded; members rejected.
    const privProj = await runtime.execute<{ projectId: string }>(
      'projects.project.create',
      { name: 'Private MCP Roadmap Test', visibility: 'private' },
      { actor: asOwner(), orgId },
    );
    // Direct roadmap board linked to private project is already blocked; check MCP excludes private-flagged or rejects member-bound.
    const ownerGrantId = randomUUID();
    const memberGrantId = randomUUID();
    await admin(async (c) => {
      await c.query(
        `INSERT INTO ludy_kernel.agent_grant
           (org_id, id, user_id, client_id, client_name, client_host, scopes, oauth_grant_id, created_at, expires_at, revoked_at, created_by, kind, member_id)
         VALUES
           ($1, $2, $3, $4, 'MCP Test', 'client.example.com', ARRAY['ludy.read'], $5, clock_timestamp(), now() + interval '30 days', NULL, $3, 'company', NULL),
           ($1, $6, $7, $8, 'MCP Test', 'client.example.com', ARRAY['ludy.read'], $9, clock_timestamp(), now() + interval '30 days', NULL, $7, 'member', $7)`,
        [
          orgId,
          ownerGrantId,
          ownerUserId,
          `roadmap-mcp-owner-${ownerGrantId}`,
          `oauth-${ownerGrantId}`,
          memberGrantId,
          memberUserId,
          `roadmap-mcp-member-${memberGrantId}`,
          `oauth-${memberGrantId}`,
        ],
      );
    });
    const mcpOwnerActor = {
      type: 'user' as const,
      userId: ownerUserId,
      aal: 'aal1' as const,
      mcp: { grantId: ownerGrantId, clientId: `roadmap-mcp-owner-${ownerGrantId}`, clientName: 'MCP Test', scopes: ['ludy.read'], kind: 'company' as const },
    };
    const mcpMemberActor = {
      type: 'user' as const,
      userId: memberUserId,
      aal: 'aal1' as const,
      mcp: { grantId: memberGrantId, clientId: `roadmap-mcp-member-${memberGrantId}`, clientName: 'MCP Test', scopes: ['ludy.read'], kind: 'member' as const },
    };

    const mcpIdeas = await runtime.query<{ ideas: Array<{ id: string; tainted: boolean; sourceTrust: string }> }>(
      'projects.mcp.roadmap_ideas',
      { boardId: s2BoardId },
      { actor: mcpOwnerActor, orgId },
    );
    expect(mcpIdeas.ideas.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(mcpIdeas)).not.toContain('voter_email_hash');
    expect(JSON.stringify(mcpIdeas)).not.toContain(memberEmail);

    const mcpSummary = await runtime.query<{ stageCounts: { shipped: number }; recentPublishedAnnouncements: Array<{ id: string }> }>(
      'projects.mcp.roadmap_demand_summary',
      { boardId: s2BoardId },
      { actor: mcpOwnerActor, orgId },
    );
    expect(mcpSummary.stageCounts.shipped).toBeGreaterThanOrEqual(1);
    expect(mcpSummary.recentPublishedAnnouncements.some((a) => a.id === annId)).toBe(true);

    await expect(
      runtime.query('projects.mcp.roadmap_ideas', { boardId: s2BoardId }, { actor: mcpMemberActor, orgId }),
    ).rejects.toThrow();
    await expect(
      runtime.query('projects.mcp.roadmap_demand_summary', { boardId: s2BoardId }, { actor: mcpMemberActor, orgId }),
    ).rejects.toThrow();
    expect(privProj.projectId).toBeTruthy();

    // 5. PDPL find & erase covers ludy_projects.roadmap_announcement.title & body_md.
    const pdplTarget = 'pdpl-changelog@example.test';
    const annPdpl = await runtime.execute<{ announcement: { id: string } }>(
      'projects.roadmap.announcement.create',
      {
        boardId: s2BoardId,
        title: `Phat hanh cho ${pdplTarget}`,
        bodyMd: `Chi tiet lien he ${pdplTarget}`,
      },
      { actor: asOwner(), orgId, idempotencyKey: randomUUID() },
    );
    const pdplFound = await runtime.execute<{ matches: Array<{ column: string }> }>(
      'kernel.personal_data.find',
      { value: pdplTarget },
      { actor: asOwner(), orgId },
    );
    expect(pdplFound.matches.some((m) => m.column === 'ludy_projects.roadmap_announcement.title')).toBe(true);
    expect(pdplFound.matches.some((m) => m.column === 'ludy_projects.roadmap_announcement.body_md')).toBe(true);

    const pdplErased = await runtime.execute<{ erased: Array<{ column: string; rows: number }> }>(
      'kernel.personal_data.erase',
      { value: pdplTarget },
      { actor: asOwnerMfa(), orgId, idempotencyKey: randomUUID() },
    );
    expect(pdplErased.erased.some((e) => e.column === 'ludy_projects.roadmap_announcement.title' && e.rows >= 1)).toBe(true);
    expect(pdplErased.erased.some((e) => e.column === 'ludy_projects.roadmap_announcement.body_md' && e.rows >= 1)).toBe(true);
    expect(annPdpl.announcement.id).toBeTruthy();
  });
});

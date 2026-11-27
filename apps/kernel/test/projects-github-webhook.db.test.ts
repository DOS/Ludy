// SPDX-License-Identifier: AGPL-3.0-only
// Projects GitHub Integration Slice 1 (#5158, ADR-0060) on a real PostgreSQL 17:
// 1) App webhook route (/api/projects/github/webhook): raw-bytes HMAC before JSON parse (current + previous secret),
//    ping acknowledgment (200), delivery dedup, and 10m pending sweep.
// 2) PAT per-hook route (/api/projects/github/webhook/:hookKey): key shown once and hashed in SQL, opaque 404 when
//    unknown, when projects app is turned off, or when org is unentitled (ADR-0053), 10-refusal auto-stop + rotation.
// 3) Opt-in binding (NULL task_number and zero GitHub config by default), owner/admin guard, <= 5 repo cap, task key
//    prefix + backfill, inbound PR/issue/push sync via worker + hydrate job, XSS/BiDi stripping, tainted = true.
// 4) Active agent checkout lease deferral via kernel.task.sync_external_status.
// 5) Social channel separation, PDPL find/erase across github_task_link + github_webhook_notice, org export, and org_purge.
// Set LUDY_TEST_ADMIN_URL (or CROVE_TEST_ADMIN_URL) to a superuser URL; each run creates and drops its own database.
import { createHmac, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';
import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createGithubClient, type GithubTransport } from '@ludy/github';
import { EXPORT_TABLE_NAMES, createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import type {
  GithubBindingGetResult,
  GithubHookStatusResult,
  GithubTaskLinksQueryResult,
  PersonalDataErasure,
  PersonalDataResult,
  ProjectBoard,
} from '@ludy/kernel-contract';
import { CredentialVault, Runtime, parseVaultKey, sha256Hex, type BlobStore, type CredentialBroker } from '@ludy/kernel-runtime';
import { financeCommands } from '@ludy/mod-finance';
import { projectsCommands, projectsQueries } from '@ludy/mod-projects';
import { createAuthenticator } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { ExportSealer, exportAad } from '../src/export-seal.ts';
import { createHttpApp } from '../src/http.ts';
import { runOrgExport } from '../src/org-export.ts';
import { orgPurgeCommand, purgeOrg } from '../src/org-purge.ts';
import {
  GITHUB_PAT_WEBHOOK_PATH,
  GITHUB_WEBHOOK_PATH,
  githubHookKeyHash,
} from '../src/projects-github-webhook.ts';
import {
  hasGithubWebhookWork,
  processGithubWebhookBatch,
  runGithubHydrateJob,
  sweepGithubWebhooks,
  type ProjectsGithubHydrateJob,
} from '../src/projects-github-worker.ts';
import { RateLimiter } from '../src/rate-limit.ts';
import { createSessionStatusSource } from '../src/sessions.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const SECRET = 'test-only-jwt-secret-for-projects-github-0123456789';
const ISSUER = 'ludy-auth';
const DAY = 24 * 60 * 60 * 1000;
const APP_WEBHOOK_SECRET = 'github-app-webhook-secret-current';
const APP_WEBHOOK_SECRET_PREV = 'github-app-webhook-secret-previous';
const PAT_WEBHOOK_SECRET = 'github-pat-webhook-secret-123456';
const suite = ADMIN ? describe : describe.skip;

class MemoryStore implements BlobStore {
  readonly blobs = new Map<string, Uint8Array>();
  async put(key: string, bytes: Uint8Array) {
    this.blobs.set(key, bytes);
    return `content:${sha256Hex(bytes)}`;
  }
  async get(key: string) {
    const b = this.blobs.get(key);
    if (!b) throw new Error(`missing blob ${key}`);
    return b;
  }
  async delete(key: string) {
    this.blobs.delete(key);
  }
}

interface Person {
  subject: string;
  email: string;
  session: string;
  userId: string;
}

function signGithubPayload(body: string | Uint8Array, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

suite('Projects GitHub Integration Slice 1 on PostgreSQL (#5158)', () => {
  const dbName = `ludy_test_projects_github_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appPool: pg.Pool;
  let workerPool: pg.Pool;
  let appDb: Db;
  let workerDb: Db;
  let runtime: Runtime;
  let workerRuntime: Runtime;
  let vault: CredentialVault;
  let sealer: ExportSealer;
  let app: ReturnType<typeof createHttpApp>;
  let appUnentitled: ReturnType<typeof createHttpApp>;
  const store = new MemoryStore();
  const keyPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const appPrivateKeyPem = keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

  const repoCatalog = [
    { id: 1001, full_name: 'octo-org/core-api', default_branch: 'main', private: true },
    { id: 1002, full_name: 'octo-org/web-app', default_branch: 'main', private: false },
    { id: 1003, full_name: 'octo-org/worker', default_branch: 'main', private: true },
    { id: 1004, full_name: 'octo-org/docs', default_branch: 'main', private: false },
    { id: 1005, full_name: 'octo-org/cli', default_branch: 'main', private: false },
    { id: 1006, full_name: 'octo-org/sdk', default_branch: 'main', private: true },
  ];

  const remoteItems = new Map<string, Record<string, unknown>>();
  const branchPrs = new Map<string, Record<string, unknown>>();
  const githubCalls: string[] = [];

  const mockTransport: GithubTransport = async (req) => {
    const parsedUrl = new URL(req.url);
    expect(parsedUrl.protocol).toBe('https:');
    const isOAuth = parsedUrl.hostname === 'github.com' && parsedUrl.pathname === '/login/oauth/access_token';
    expect(parsedUrl.hostname === 'api.github.com' || isOAuth).toBe(true);
    const pathWithQuery = `${parsedUrl.pathname}${parsedUrl.search}`;
    githubCalls.push(`${req.method} ${pathWithQuery}`);

    if (req.method === 'POST' && isOAuth) {
      const params = new URLSearchParams(req.body ?? '');
      const code = params.get('code') ?? '';
      if (code === 'code-install-777') {
        return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ access_token: 'ghu_user_777_token_test', token_type: 'bearer' }) };
      }
      if (code === 'code-install-888') {
        return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ access_token: 'ghu_user_888_token_test', token_type: 'bearer' }) };
      }
      if (code === 'code-other-user') {
        return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ access_token: 'ghu_user_999_token_test', token_type: 'bearer' }) };
      }
      if (code === 'code-empty-user') {
        return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ access_token: 'ghu_user_empty_token_test', token_type: 'bearer' }) };
      }
      if (code === 'code-multi-user') {
        return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ access_token: 'ghu_user_multi_token_test', token_type: 'bearer' }) };
      }
      return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: 'bad_verification_code' }) };
    }
    if (req.method === 'GET' && parsedUrl.pathname === '/user/installations') {
      const auth = req.headers.authorization ?? '';
      if (auth === 'Bearer ghu_user_777_token_test') {
        return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ total_count: 1, installations: [{ id: 777, account: { login: 'octo-org', type: 'Organization' } }] }) };
      }
      if (auth === 'Bearer ghu_user_888_token_test') {
        return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ total_count: 1, installations: [{ id: 888, account: { login: 'octo-org-2', type: 'Organization' } }] }) };
      }
      if (auth === 'Bearer ghu_user_999_token_test') {
        return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ total_count: 1, installations: [{ id: 999, account: { login: 'other-org', type: 'Organization' } }] }) };
      }
      if (auth === 'Bearer ghu_user_empty_token_test') {
        return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ total_count: 0, installations: [] }) };
      }
      if (auth === 'Bearer ghu_user_multi_token_test') {
        return {
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            total_count: 2,
            installations: [
              { id: 777, account: { login: 'octo-org', type: 'Organization' } },
              { id: 888, account: { login: 'octo-org-2', type: 'Organization' } },
            ],
          }),
        };
      }
    }
    if (req.method === 'POST' && /^\/app\/installations\/(777|888|999)\/access_tokens$/.test(parsedUrl.pathname)) {
      const instId = parsedUrl.pathname.split('/')[3];
      return {
        status: 201,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          token: `ghs_installation_token_${instId}`,
          expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
        }),
      };
    }
    if (req.method === 'GET' && /^\/app\/installations\/(777|888|999)$/.test(parsedUrl.pathname)) {
      const instId = Number(parsedUrl.pathname.split('/')[3]);
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: instId, account: { id: 9000 + instId, login: instId === 777 ? 'octo-org' : `org-${instId}` } }),
      };
    }
    if (req.method === 'GET' && parsedUrl.pathname === '/installation/repositories') {
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ repositories: repoCatalog }),
      };
    }
    if (req.method === 'GET' && parsedUrl.pathname === '/user') {
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 4242, login: 'pat-bot-user' }),
      };
    }
    if (req.method === 'GET' && parsedUrl.pathname === '/user/repos') {
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(repoCatalog.slice(0, 2)),
      };
    }
    if (req.method === 'GET' && parsedUrl.pathname === '/repos/octo-org/core-api/pulls' && parsedUrl.searchParams.has('head')) {
      const head = parsedUrl.searchParams.get('head') ?? '';
      const found = branchPrs.get(head);
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(found ? [found] : []),
      };
    }
    const item = remoteItems.get(parsedUrl.pathname);
    if (item) {
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(item),
      };
    }
    return {
      status: 404,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'Not Found' }),
    };
  };

  const githubClient = createGithubClient({
    transport: mockTransport,
    app: { appId: '123456', privateKeyPem: appPrivateKeyPem },
    appOAuth: { clientId: 'gh_oauth_client_test', clientSecret: 'gh_oauth_secret_test_012345' },
  });

  const owner: Person = { subject: 'gh-owner', email: 'gh-owner@ludy.test', session: randomUUID(), userId: '' };
  const member: Person = { subject: 'gh-member', email: 'gh-member@ludy.test', session: randomUUID(), userId: '' };
  const viewer: Person = { subject: 'gh-viewer', email: 'gh-viewer@ludy.test', session: randomUUID(), userId: '' };
  const outsider: Person = { subject: 'gh-outsider', email: 'gh-outsider@ludy.test', session: randomUUID(), userId: '' };

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }
  const rows = <T extends pg.QueryResultRow = Record<string, unknown>>(text: string, values: unknown[] = []) =>
    admin(async (c) => (await c.query<T>(text, values)).rows);

  async function tokenFor(who: Person) {
    return new SignJWT({ role: 'authenticated', email: who.email, session_id: who.session, aal: 'aal1', is_anonymous: false })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(who.subject)
      .setIssuer(ISSUER)
      .setAudience('authenticated')
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(new TextEncoder().encode(SECRET));
  }

  async function rpc(
    targetApp: ReturnType<typeof createHttpApp>,
    path: string,
    who: Person,
    input: unknown,
    orgSlug?: string | null,
  ) {
    const response = await targetApp.request(`/api/rpc/${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await tokenFor(who)}`,
        'content-type': 'application/json',
        ...(orgSlug ? { 'x-ludy-org': orgSlug } : {}),
      },
      body: JSON.stringify(input === undefined ? {} : { json: input }),
    });
    const text = await response.text();
    const parsed = (text ? JSON.parse(text) : null) as ({ json?: unknown } & Record<string, unknown>) | null;
    return {
      status: response.status,
      body: (parsed && 'json' in parsed ? parsed.json : parsed) as Record<string, unknown> | null,
    };
  }

  const asMfa = (userId: string) => ({
    type: 'user' as const,
    userId,
    aal: 'aal2' as const,
    sessionId: randomUUID(),
    mfaAt: Math.floor(Date.now() / 1000),
  });
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const, sessionId: randomUUID() });

  beforeAll(async () => {
    const root = new pg.Client({ connectionString: ADMIN as string });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();

    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();

    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { ludy_app: 'gh-app-pw', ludy_worker: 'gh-worker-pw' });

    const login = (username: string, password: string) => {
      const url = new URL(adminUrl);
      url.username = username;
      url.password = password;
      return url.toString();
    };

    const appConn = login('ludy_app', 'gh-app-pw');
    const workerConn = login('ludy_worker', 'gh-worker-pw');
    appPool = createPool({ connectionString: appConn, max: 6 });
    workerPool = createPool({ connectionString: workerConn, max: 4 });
    appDb = createDb(appPool);
    workerDb = createDb(workerPool);

    vault = new CredentialVault([parseVaultKey(randomBytes(32).toString('base64'))]);
    sealer = new ExportSealer(randomBytes(32));

    const registry = {
      commands: [...kernelCommands, ...projectsCommands, ...financeCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...projectsQueries],
    };
    runtime = new Runtime(appDb, { manifests: TEST_MANIFESTS, sessions: createSessionStatusSource('off'), stepUp: 'off' }).register(registry);
    workerRuntime = new Runtime(workerDb, { manifests: TEST_MANIFESTS })
      .register(registry)
      .register({ commands: [orgPurgeCommand({ store })] });

    const config = loadConfig({
      DATABASE_URL: appConn,
      AUTH_JWT_SECRET: SECRET,
      AUTH_ISSUER: ISSUER,
      AUTH_SESSION_CHECK: 'off',
      PUBLIC_URL: 'http://localhost:8080',
      MIGRATIONS_DIR: MIGRATIONS,
      WEB_DIST: '/nonexistent',
    });

    const commonHttp = {
      config,
      runtime,
      store,
      authenticate: createAuthenticator(config, appDb),
      pool: appPool,
      aiEnabled: false,
      channels: { broker: vault, sandbox: false, github: githubClient, publicUrl: 'http://localhost:8080' },
      githubWebhook: { appWebhookSecret: APP_WEBHOOK_SECRET, appWebhookSecretPrevious: APP_WEBHOOK_SECRET_PREV },
      githubWebhookLimits: { address: new RateLimiter({ perMinute: 1000 }), hook: new RateLimiter({ perMinute: 1000 }) },
    };
    app = createHttpApp({ ...commonHttp, billing: { entitlements: async () => ['full'] } });
    appUnentitled = createHttpApp({ ...commonHttp, billing: { entitlements: async () => [] } });

    owner.userId = await upsertIdentity(appDb, { issuer: ISSUER, subject: owner.subject, email: owner.email, name: 'GH Owner' });
    member.userId = await upsertIdentity(appDb, { issuer: ISSUER, subject: member.subject, email: member.email, name: 'GH Member' });
    viewer.userId = await upsertIdentity(appDb, { issuer: ISSUER, subject: viewer.subject, email: viewer.email, name: 'GH Viewer' });
    outsider.userId = await upsertIdentity(appDb, { issuer: ISSUER, subject: outsider.subject, email: outsider.email, name: 'GH Outsider' });
  }, 120_000);

  afterAll(async () => {
    await appPool?.end();
    await workerPool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN as string });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('keeps zero GitHub setup by default, enforces permissions & 5-repo cap, syncs App webhooks + hydration + checkout lease deferral', async () => {
    const org = await createOrg(runtime, asUser(owner.userId), 'Cong ty GitHub App');
    await rows("INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'viewer')", [org.orgId, member.userId, viewer.userId]);

    const { projectId } = await runtime.execute<{ projectId: string }>(
      'projects.project.create',
      { name: 'Du an Core' },
      { actor: asUser(owner.userId), orgId: org.orgId, idempotencyKey: randomUUID() },
    );
    const { taskId: t1 } = await runtime.execute<{ taskId: string }>(
      'projects.task.create',
      { projectId, title: 'Fix oauth login crash', assigneePositionId: null },
      { actor: asUser(owner.userId), orgId: org.orgId, idempotencyKey: randomUUID() },
    );

    // 1) Opt-in default: task_number is NULL, taskKey is NULL, githubEnabled is false.
    const defaultBoard = await runtime.query<ProjectBoard>('projects.board', { projectId }, { actor: asUser(owner.userId), orgId: org.orgId });
    expect(defaultBoard.project.githubEnabled).toBe(false);
    expect(defaultBoard.project.taskKeyPrefix).toBeNull();
    expect(defaultBoard.tasks[0]).toMatchObject({ id: t1, taskNumber: null, taskKey: null, githubLinkCount: 0 });
    const rawNumBefore = await rows<{ task_number: number | null }>('SELECT task_number FROM ludy_projects.project_task WHERE org_id = $1 AND task_id = $2', [org.orgId, t1]);
    expect(rawNumBefore).toEqual([{ task_number: null }]);

    const initialBinding = await runtime.query<GithubBindingGetResult>('projects.github.binding.get', { projectId }, { actor: asUser(owner.userId), orgId: org.orgId });
    expect(initialBinding.binding).toBeNull();

    // Member cannot start OAuth or connect GitHub App or PAT.
    const memberDenied = await rpc(
      app,
      'projects/github/connectApp',
      member,
      { projectId, state: '0'.repeat(32), code: 'code-install-777', installationId: '777', taskKeyPrefix: 'ACME', idempotencyKey: randomUUID() },
      org.slug,
    );
    expect(memberDenied.status).toBe(403);

    // Owner starts GitHub App OAuth and connects verified installation 777 with prefix ACME and backfillTaskNumbers = true.
    const oauthStarted = await rpc(app, 'projects/github/appOAuthStart', owner, { projectId }, org.slug);
    expect(oauthStarted.status).toBe(200);
    const oauthState = String(oauthStarted.body?.state ?? '');
    expect(oauthState.length).toBeGreaterThanOrEqual(16);

    const connected = await rpc(
      app,
      'projects/github/connectApp',
      owner,
      { projectId, state: oauthState, code: 'code-install-777', installationId: '777', taskKeyPrefix: 'ACME', backfillTaskNumbers: true, idempotencyKey: randomUUID() },
      org.slug,
    );
    expect(connected.status).toBe(200);
    expect(connected.body?.backfilledCount).toBe(1);
    expect((connected.body?.availableRepos as unknown[])?.length).toBe(6);

    // B1.3: externalAccountId is exposed to owner/admin and nulled for member/viewer.
    const ownerBindingView = await rpc(app, 'projects/github/bindingGet', owner, { projectId }, org.slug);
    expect((ownerBindingView.body?.binding as { externalAccountId?: unknown } | null)?.externalAccountId).toBe('777');
    const memberBindingView = await rpc(app, 'projects/github/bindingGet', member, { projectId }, org.slug);
    expect((memberBindingView.body?.binding as { externalAccountId?: unknown } | null)?.externalAccountId).toBeNull();
    const viewerBindingView = await rpc(app, 'projects/github/bindingGet', viewer, { projectId }, org.slug);
    expect((viewerBindingView.body?.binding as { externalAccountId?: unknown } | null)?.externalAccountId).toBeNull();

    // Social/Inbox channel list excludes github_app / github_pat.
    const socialChannels = await runtime.query<Array<{ provider: string }>>('kernel.channel.list', {}, { actor: asUser(owner.userId), orgId: org.orgId });
    expect(socialChannels.some((c) => c.provider === 'github_app' || c.provider === 'github_pat')).toBe(false);

    // Subsequent tasks receive ACME-2, ACME-3, ACME-4.
    const { agentId, positionId } = await runtime.execute<{ agentId: string; positionId: string }>(
      'kernel.agent.template.install',
      { templateKey: 'finance.chief_accountant' },
      { actor: asMfa(owner.userId), orgId: org.orgId, idempotencyKey: randomUUID() },
    );
    const { taskId: t2 } = await runtime.execute<{ taskId: string }>(
      'projects.task.create',
      { projectId, title: 'Agent checked-out task', assigneePositionId: positionId },
      { actor: asUser(owner.userId), orgId: org.orgId, idempotencyKey: randomUUID() },
    );
    const { taskId: t3 } = await runtime.execute<{ taskId: string }>(
      'projects.task.create',
      { projectId, title: 'Unlocked task to auto-close', assigneePositionId: null },
      { actor: asUser(owner.userId), orgId: org.orgId, idempotencyKey: randomUUID() },
    );
    const { taskId: t4 } = await runtime.execute<{ taskId: string }>(
      'projects.task.create',
      { projectId, title: 'Branch push hydrate task', assigneePositionId: null },
      { actor: asUser(owner.userId), orgId: org.orgId, idempotencyKey: randomUUID() },
    );

    const optedBoard = await runtime.query<ProjectBoard>('projects.board', { projectId }, { actor: asUser(owner.userId), orgId: org.orgId });
    expect(optedBoard.project).toMatchObject({ githubEnabled: true, taskKeyPrefix: 'ACME' });
    const byId = new Map(optedBoard.tasks.map((t) => [t.id, t]));
    expect(byId.get(t1)).toMatchObject({ taskNumber: 1, taskKey: 'ACME-1' });
    expect(byId.get(t2)).toMatchObject({ taskNumber: 2, taskKey: 'ACME-2' });
    expect(byId.get(t3)).toMatchObject({ taskNumber: 3, taskKey: 'ACME-3' });
    expect(byId.get(t4)).toMatchObject({ taskNumber: 4, taskKey: 'ACME-4' });

    // 2) Bind up to 5 repos; 6th fails with 409 GITHUB_REPO_LIMIT_REACHED.
    for (let i = 0; i < 5; i += 1) {
      const repo = repoCatalog[i]!;
      const res = await rpc(
        app,
        'projects/github/repoBind',
        owner,
        {
          projectId,
          githubRepoId: String(repo.id),
          repoFullName: repo.full_name,
          defaultBranch: repo.default_branch,
          webhookConfigured: true,
          idempotencyKey: randomUUID(),
        },
        org.slug,
      );
      expect(res.status).toBe(200);
    }
    const sixth = await rpc(
      app,
      'projects/github/repoBind',
      owner,
      {
        projectId,
        githubRepoId: String(repoCatalog[5]!.id),
        repoFullName: repoCatalog[5]!.full_name,
        defaultBranch: repoCatalog[5]!.default_branch,
        idempotencyKey: randomUUID(),
      },
      org.slug,
    );
    expect(sixth.status).toBe(409);

    // 3) Agent checks out ACME-2 with active lease.
    const runRows = await rows<{ id: string }>(
      `INSERT INTO ludy_kernel.ai_run (org_id, agent_id, module, status, started_at, expires_at)
       VALUES ($1::uuid, $2::uuid, 'finance', 'running', now(), now() + interval '15 minutes')
       RETURNING id`,
      [org.orgId, agentId],
    );
    const runId = runRows[0]!.id;
    await workerRuntime.execute(
      'kernel.task.checkout',
      { id: t2 },
      { actor: { type: 'agent', agentId, runId }, orgId: org.orgId, idempotencyKey: randomUUID() },
    );

    // 4) Public App webhook checks raw HMAC BEFORE JSON parsing.
    const badRawRes = await app.request(GITHUB_WEBHOOK_PATH, {
      method: 'POST',
      headers: {
        'x-github-event': 'pull_request',
        'x-github-delivery': randomUUID(),
        'x-hub-signature-256': 'sha256=deadbeef',
      },
      body: 'not-even-valid-json{{{',
    });
    expect(badRawRes.status).toBe(401);
    expect(await hasGithubWebhookWork(workerDb)).toBe(false);

    // Ping with valid previous rotated secret acknowledges cleanly (200) without queueing.
    const pingBody = JSON.stringify({ zen: 'Practicality beats purity.', hook_id: 1 });
    const pingRes = await app.request(GITHUB_WEBHOOK_PATH, {
      method: 'POST',
      headers: {
        'x-github-event': 'ping',
        'x-github-delivery': randomUUID(),
        'x-hub-signature-256': signGithubPayload(pingBody, APP_WEBHOOK_SECRET_PREV),
      },
      body: pingBody,
    });
    expect(pingRes.status).toBe(200);
    expect(await pingRes.json()).toEqual({ ok: true, ignored: true });

    // Deliver PR opened (mentions Fixes ACME-1 with XSS + BiDi characters).
    const pr1Body = JSON.stringify({
      action: 'opened',
      installation: { id: 777 },
      repository: { id: 1001, full_name: 'octo-org/core-api' },
      pull_request: {
        number: 101,
        html_url: 'https://github.com/octo-org/core-api/pull/101',
        title: '<script>alert(1)</script>\u202eFix oauth crash',
        body: 'Fixes ACME-1\nDetails: https://evil.test',
        state: 'open',
        draft: false,
        merged: false,
        head: { ref: 'fix/login' },
        user: { login: 'octo\u202ecat' },
        updated_at: '2026-11-27T01:00:00Z',
      },
    });
    const delivery1 = randomUUID();
    const pr1Res = await app.request(GITHUB_WEBHOOK_PATH, {
      method: 'POST',
      headers: {
        'x-github-event': 'pull_request',
        'x-github-delivery': delivery1,
        'x-hub-signature-256': signGithubPayload(pr1Body, APP_WEBHOOK_SECRET),
      },
      body: pr1Body,
    });
    expect(pr1Res.status).toBe(202);
    // Duplicate delivery returns cleanly without second row.
    const pr1Dup = await app.request(GITHUB_WEBHOOK_PATH, {
      method: 'POST',
      headers: {
        'x-github-event': 'pull_request',
        'x-github-delivery': delivery1,
        'x-hub-signature-256': signGithubPayload(pr1Body, APP_WEBHOOK_SECRET),
      },
      body: pr1Body,
    });
    expect(pr1Dup.status).toBe(202);

    // Deliver merged PR against checked-out ACME-2 AND unlocked ACME-3.
    const deliverPr = async (num: number, prBodyText: string, merged: boolean) => {
      const payload = JSON.stringify({
        action: merged ? 'closed' : 'opened',
        installation: { id: 777 },
        repository: { id: 1001, full_name: 'octo-org/core-api' },
        pull_request: {
          number: num,
          html_url: `https://github.com/octo-org/core-api/pull/${num}`,
          title: `PR #${num}`,
          body: prBodyText,
          state: merged ? 'closed' : 'open',
          draft: false,
          merged,
          merged_at: merged ? '2026-11-27T01:05:00Z' : null,
          head: { ref: `feat/pr-${num}` },
          user: { login: 'merger' },
          updated_at: '2026-11-27T01:05:00Z',
        },
      });
      const r = await app.request(GITHUB_WEBHOOK_PATH, {
        method: 'POST',
        headers: {
          'x-github-event': 'pull_request',
          'x-github-delivery': randomUUID(),
          'x-hub-signature-256': signGithubPayload(payload, APP_WEBHOOK_SECRET),
        },
        body: payload,
      });
      expect(r.status).toBe(202);
    };
    await deliverPr(102, 'Closes ACME-2', true);
    await deliverPr(103, 'Closes ACME-3', true);

    // Deliver branch push referencing ACME-4.
    const pushBody = JSON.stringify({
      ref: 'refs/heads/feat/acme-4-sso',
      installation: { id: 777 },
      repository: { id: 1001, full_name: 'octo-org/core-api' },
      commits: [{ id: 'a'.repeat(40), message: 'wip branch push' }],
    });
    const pushRes = await app.request(GITHUB_WEBHOOK_PATH, {
      method: 'POST',
      headers: {
        'x-github-event': 'push',
        'x-github-delivery': randomUUID(),
        'x-hub-signature-256': signGithubPayload(pushBody, APP_WEBHOOK_SECRET),
      },
      body: pushBody,
    });
    expect(pushRes.status).toBe(202);

    const hydrateQueue: ProjectsGithubHydrateJob[] = [];
    const batch = await processGithubWebhookBatch({
      workerDb,
      runtime: workerRuntime,
      broker: vault,
      appWebhookSecrets: [APP_WEBHOOK_SECRET, APP_WEBHOOK_SECRET_PREV],
      sendHydrate: async (job) => {
        hydrateQueue.push(job);
      },
    });
    // Staging claimed 5 pending rows (including duplicate delivery1), while delivery ledger dedups delivery1 to 1 row.
    expect(batch.appProcessed).toBe(5);
    expect(hydrateQueue).toHaveLength(1);
    expect(hydrateQueue[0]).toMatchObject({ mode: 'branch_pr', repoFullName: 'octo-org/core-api', branchName: 'feat/acme-4-sso', taskNumbers: [4] });

    // Hydrate ACME-4 branch PR via mock GithubClient.
    branchPrs.set('octo-org:feat/acme-4-sso', {
      number: 104,
      html_url: 'https://github.com/octo-org/core-api/pull/104',
      title: 'SSO branch PR',
      state: 'open',
      draft: false,
      merged: false,
      merged_at: null,
      head: { ref: 'feat/acme-4-sso' },
      user: { login: 'sso-author' },
      updated_at: '2026-11-27T01:10:00Z',
    });
    expect(await runGithubHydrateJob({ runtime: workerRuntime, workerDb, broker: vault, github: githubClient }, hydrateQueue[0]!)).toBe('hydrated');

    // Verify task statuses & sanitized links in DB.
    const taskRows = await rows<{ id: string; status: string }>(
      'SELECT id, status FROM ludy_kernel.task WHERE org_id = $1 AND id = ANY($2::uuid[])',
      [org.orgId, [t1, t2, t3, t4]],
    );
    const statusOf = new Map(taskRows.map((r) => [r.id, r.status]));
    expect(statusOf.get(t1)).toBe('in_progress');
    expect(statusOf.get(t2)).toBe('in_progress'); // Deferred due to active agent checkout lease!
    expect(statusOf.get(t3)).toBe('done');
    expect(statusOf.get(t4)).toBe('in_progress');

    const linkRows = await rows<{ task_id: string; external_number: number; external_title: string; author_login: string | null; tainted: boolean }>(
      'SELECT task_id, external_number, external_title, author_login, tainted FROM ludy_projects.github_task_link WHERE org_id = $1 AND project_id = $2 ORDER BY external_number',
      [org.orgId, projectId],
    );
    expect(linkRows).toHaveLength(4);
    expect(linkRows[0]).toMatchObject({ task_id: t1, external_number: 101, tainted: true });
    expect(linkRows[0]!.external_title).not.toContain('<script>');
    expect(linkRows[0]!.external_title).not.toContain('\u202e');
    expect(linkRows[0]!.author_login).not.toContain('\u202e');

    const deliveryOutcomes = await rows<{ delivery_id: string; external_number: number | null; status: string }>(
      'SELECT delivery_id, external_number, status FROM ludy_projects.github_sync_delivery WHERE org_id = $1 AND project_id = $2 ORDER BY received_at',
      [org.orgId, projectId],
    );
    expect(deliveryOutcomes.filter((d) => d.delivery_id === delivery1)).toHaveLength(1);
    expect(deliveryOutcomes.some((d) => d.external_number === 102 && d.status === 'deferred')).toBe(true);
    expect(deliveryOutcomes.some((d) => d.external_number === 103 && d.status === 'applied')).toBe(true);

    // Out-of-order older webhook timestamp does not regress PR 101 title or reopen state.
    const stalePr1Body = JSON.stringify({
      action: 'closed',
      installation: { id: 777 },
      repository: { id: 1001, full_name: 'octo-org/core-api' },
      pull_request: {
        number: 101,
        html_url: 'https://github.com/octo-org/core-api/pull/101',
        title: 'Stale Old PR Title',
        body: 'Fixes ACME-1',
        state: 'closed',
        draft: false,
        merged: false,
        head: { ref: 'fix/login' },
        user: { login: 'octocat' },
        updated_at: '2026-11-27T00:50:00Z',
      },
    });
    await app.request(GITHUB_WEBHOOK_PATH, {
      method: 'POST',
      headers: {
        'x-github-event': 'pull_request',
        'x-github-delivery': randomUUID(),
        'x-hub-signature-256': signGithubPayload(stalePr1Body, APP_WEBHOOK_SECRET),
      },
      body: stalePr1Body,
    });
    await processGithubWebhookBatch({
      workerDb,
      runtime: workerRuntime,
      broker: vault,
      appWebhookSecrets: [APP_WEBHOOK_SECRET],
    });
    const pr101AfterStale = await rows<{ external_title: string; external_state: string }>(
      'SELECT external_title, external_state FROM ludy_projects.github_task_link WHERE org_id = $1 AND project_id = $2 AND external_number = 101',
      [org.orgId, projectId],
    );
    expect(pr101AfterStale[0]).toEqual({ external_title: 'alert(1) Fix oauth crash', external_state: 'open' });

    // Viewer (read-only) and member with non-project taskId fail authorization BEFORE calling api.github.com;
    // writer pasting an /issues/205 URL that belongs to a PR stores kind = 'pull_request' and canonical /pull/205 URL.
    remoteItems.set('/repos/octo-org/core-api/issues/205', {
      number: 205,
      html_url: 'https://github.com/octo-org/core-api/issues/205',
      title: 'PR resolved via issues URL',
      state: 'open',
      pull_request: {},
      user: { login: 'pr-via-issue' },
      updated_at: '2026-11-27T01:15:00Z',
    });
    remoteItems.set('/repos/octo-org/core-api/pulls/205', {
      number: 205,
      html_url: 'https://github.com/octo-org/core-api/pull/205',
      title: 'PR resolved via issues URL',
      state: 'open',
      draft: false,
      merged: false,
      head: { ref: 'fix/issues-url' },
      user: { login: 'pr-via-issue' },
      updated_at: '2026-11-27T01:15:00Z',
    });
    const callsBeforeViewer = githubCalls.length;
    const viewerLinkDenied = await rpc(
      app,
      'projects/github/taskLinkAdd',
      viewer,
      { projectId, taskId: t1, url: 'https://github.com/octo-org/core-api/issues/205', idempotencyKey: randomUUID() },
      org.slug,
    );
    expect(viewerLinkDenied.status).toBe(403);
    expect(githubCalls.length).toBe(callsBeforeViewer);

    const badTaskDenied = await rpc(
      app,
      'projects/github/taskLinkAdd',
      member,
      { projectId, taskId: randomUUID(), url: 'https://github.com/octo-org/core-api/issues/205', idempotencyKey: randomUUID() },
      org.slug,
    );
    expect(badTaskDenied.status).toBe(404);
    expect(githubCalls.length).toBe(callsBeforeViewer);

    const memberIssuePrLink = await rpc(
      app,
      'projects/github/taskLinkAdd',
      member,
      { projectId, taskId: t1, url: 'https://github.com/octo-org/core-api/issues/205', idempotencyKey: randomUUID() },
      org.slug,
    );
    expect(memberIssuePrLink.status).toBe(200);
    expect(memberIssuePrLink.body?.link).toMatchObject({
      kind: 'pull_request',
      externalNumber: 205,
      externalUrl: 'https://github.com/octo-org/core-api/pull/205',
      branchName: 'fix/issues-url',
      hydrating: false,
    });

    // 5) Installation deletion webhook pauses App binding and clears repo webhook_configured.
    const uninstallBody = JSON.stringify({
      action: 'deleted',
      installation: { id: 777, account: { id: 9001, login: 'octo-org' } },
    });
    const uninstallRes = await app.request(GITHUB_WEBHOOK_PATH, {
      method: 'POST',
      headers: {
        'x-github-event': 'installation',
        'x-github-delivery': randomUUID(),
        'x-hub-signature-256': signGithubPayload(uninstallBody, APP_WEBHOOK_SECRET),
      },
      body: uninstallBody,
    });
    expect(uninstallRes.status).toBe(202);
    const uninstallBatch = await processGithubWebhookBatch({
      workerDb,
      runtime: workerRuntime,
      broker: vault,
      appWebhookSecrets: [APP_WEBHOOK_SECRET],
    });
    expect(uninstallBatch.appProcessed).toBe(1);
    const pausedBinding = await rows<{ github_enabled: boolean; paused_reason: string | null; paused_at: string | null; conn_status: string }>(
      `SELECT b.github_enabled, b.paused_reason, b.paused_at, c.status AS conn_status
       FROM ludy_projects.github_project_binding b
       JOIN ludy_kernel.channel_connection c ON c.org_id = b.org_id AND c.id = b.channel_connection_id
       WHERE b.org_id = $1 AND b.project_id = $2`,
      [org.orgId, projectId],
    );
    expect(pausedBinding[0]!.github_enabled).toBe(false);
    expect(pausedBinding[0]!.paused_reason).toBe('installation_deleted');
    expect(pausedBinding[0]!.paused_at).not.toBeNull();
    expect(pausedBinding[0]!.conn_status).toBe('revoked');
    const remainingRepos = await rows<{ n: string }>('SELECT count(*)::text AS n FROM ludy_projects.github_project_repo WHERE org_id = $1 AND project_id = $2', [org.orgId, projectId]);
    expect(remainingRepos[0]?.n).toBe('0');
    const remainingCreds = await rows<{ n: string }>('SELECT count(*)::text AS n FROM ludy_kernel.credential c JOIN ludy_projects.github_project_binding b ON b.channel_connection_id = c.connection_id WHERE b.org_id = $1 AND b.project_id = $2', [org.orgId, projectId]);
    expect(remainingCreds[0]?.n).toBe('0');
  });

  it('enforces PAT :hookKey opaque 404 (off/unentitled), 10-refusal auto-stop, rotation, 10m sweep, PDPL erase, export, and org_purge', async () => {
    const orgA = await createOrg(runtime, asUser(owner.userId), 'Cong ty PAT Sync');
    const orgB = await createOrg(runtime, asUser(outsider.userId), 'Cong ty Khac Con Nguyen');

    const { projectId: projA } = await runtime.execute<{ projectId: string }>(
      'projects.project.create',
      { name: 'PAT Sync Project' },
      { actor: asUser(owner.userId), orgId: orgA.orgId, idempotencyKey: randomUUID() },
    );
    const { projectId: projB } = await runtime.execute<{ projectId: string }>(
      'projects.project.create',
      { name: 'Untouched Org Project' },
      { actor: asUser(outsider.userId), orgId: orgB.orgId, idempotencyKey: randomUUID() },
    );

    const { taskId: patTask } = await runtime.execute<{ taskId: string }>(
      'projects.task.create',
      { projectId: projA, title: 'PAT webhook issue fix', assigneePositionId: null },
      { actor: asUser(owner.userId), orgId: orgA.orgId, idempotencyKey: randomUUID() },
    );
    await runtime.execute<{ taskId: string }>(
      'projects.task.create',
      { projectId: projB, title: 'Keep me intact', assigneePositionId: null },
      { actor: asUser(outsider.userId), orgId: orgB.orgId, idempotencyKey: randomUUID() },
    );

    // Connect PAT for projA and projB.
    const connectPatA = await rpc(
      app,
      'projects/github/connectPat',
      owner,
      {
        projectId: projA,
        accessToken: 'github_pat_fake_token_A',
        webhookSecret: PAT_WEBHOOK_SECRET,
        taskKeyPrefix: 'PAT',
        backfillTaskNumbers: true,
        idempotencyKey: randomUUID(),
      },
      orgA.slug,
    );
    expect(connectPatA.status).toBe(200);
    const webhookUrlA = String(connectPatA.body?.webhookUrl ?? '');
    const hookKeyA = webhookUrlA.split('/').pop()!;
    expect(hookKeyA).toHaveLength(32);

    const connectPatB = await rpc(
      app,
      'projects/github/connectPat',
      outsider,
      {
        projectId: projB,
        accessToken: 'github_pat_fake_token_B',
        webhookSecret: PAT_WEBHOOK_SECRET,
        taskKeyPrefix: 'KEEP',
        backfillTaskNumbers: true,
        idempotencyKey: randomUUID(),
      },
      orgB.slug,
    );
    expect(connectPatB.status).toBe(200);

    // Bind repo to both.
    await rpc(
      app,
      'projects/github/repoBind',
      owner,
      { projectId: projA, githubRepoId: '1001', repoFullName: 'octo-org/core-api', defaultBranch: 'main', webhookConfigured: true, idempotencyKey: randomUUID() },
      orgA.slug,
    );
    await rpc(
      app,
      'projects/github/repoBind',
      outsider,
      { projectId: projB, githubRepoId: '1002', repoFullName: 'octo-org/web-app', defaultBranch: 'main', webhookConfigured: true, idempotencyKey: randomUUID() },
      orgB.slug,
    );

    // Verify DB stores SHA-256 hash only, never plaintext hookKeyA.
    const hookRow = await rows<{ hook_key_sha256: string; channel_connection_id: string }>(
      'SELECT hook_key_sha256, channel_connection_id FROM ludy_projects.github_webhook_hook WHERE org_id = $1',
      [orgA.orgId],
    );
    expect(hookRow).toHaveLength(1);
    expect(hookRow[0]!.hook_key_sha256).toBe(githubHookKeyHash(hookKeyA));

    // Opaque 404 checks (ADR-0053):
    // 1. Unknown / bad hookKey -> 404 NOT_FOUND
    const unknownHookRes = await app.request(GITHUB_PAT_WEBHOOK_PATH.replace(':hookKey', 'UnknownHookKeyOf32Characters0000'), {
      method: 'POST',
      headers: { 'x-github-event': 'issues', 'x-github-delivery': randomUUID(), 'x-hub-signature-256': 'sha256=abcd' },
      body: '{}',
    });
    expect(unknownHookRes.status).toBe(404);
    expect(await unknownHookRes.json()).toEqual({ code: 'NOT_FOUND' });

    // 2. Unentitled deployment -> 404 NOT_FOUND
    const unentitledRes = await appUnentitled.request(GITHUB_PAT_WEBHOOK_PATH.replace(':hookKey', hookKeyA), {
      method: 'POST',
      headers: { 'x-github-event': 'issues', 'x-github-delivery': randomUUID(), 'x-hub-signature-256': 'sha256=abcd' },
      body: '{}',
    });
    expect(unentitledRes.status).toBe(404);
    expect(await unentitledRes.json()).toEqual({ code: 'NOT_FOUND' });

    // 3. Projects app turned off via kernel.org.set_app -> 404 NOT_FOUND
    await runtime.execute('kernel.org.set_app', { module: 'projects', enabled: false }, { actor: asUser(owner.userId), orgId: orgA.orgId, idempotencyKey: randomUUID() });
    const appOffRes = await app.request(GITHUB_PAT_WEBHOOK_PATH.replace(':hookKey', hookKeyA), {
      method: 'POST',
      headers: { 'x-github-event': 'issues', 'x-github-delivery': randomUUID(), 'x-hub-signature-256': 'sha256=abcd' },
      body: '{}',
    });
    expect(appOffRes.status).toBe(404);
    expect(await appOffRes.json()).toEqual({ code: 'NOT_FOUND' });

    // Turn projects app back ON.
    await runtime.execute('kernel.org.set_app', { module: 'projects', enabled: true }, { actor: asUser(owner.userId), orgId: orgA.orgId, idempotencyKey: randomUUID() });

    // Ping on valid PAT hook returns 200 ignored without queuing.
    const patPing = await app.request(GITHUB_PAT_WEBHOOK_PATH.replace(':hookKey', hookKeyA), {
      method: 'POST',
      headers: { 'x-github-event': 'ping', 'x-github-delivery': randomUUID(), 'x-hub-signature-256': signGithubPayload('{}', PAT_WEBHOOK_SECRET) },
      body: '{}',
    });
    expect(patPing.status).toBe(200);
    expect(await patPing.json()).toEqual({ ok: true, ignored: true });

    // Valid signed issue webhook mentions PAT-1 -> syncs & creates link.
    const issuePayload = JSON.stringify({
      action: 'opened',
      repository: { id: 1001, full_name: 'octo-org/core-api' },
      issue: {
        number: 55,
        html_url: 'https://github.com/octo-org/core-api/issues/55',
        title: 'Bug report from pdpl.reporter@github.example.test',
        body: 'Tracks PAT-1 cleanly',
        state: 'open',
        user: { login: 'pdpl-reporter' },
        updated_at: '2026-11-27T02:00:00Z',
      },
    });
    const issuePost = await app.request(GITHUB_PAT_WEBHOOK_PATH.replace(':hookKey', hookKeyA), {
      method: 'POST',
      headers: {
        'x-github-event': 'issues',
        'x-github-delivery': randomUUID(),
        'x-hub-signature-256': signGithubPayload(issuePayload, PAT_WEBHOOK_SECRET),
      },
      body: issuePayload,
    });
    expect(issuePost.status).toBe(202);
    expect(await issuePost.json()).toEqual({ queued: true });
    // Invoke without appWebhookSecrets (matching production worker.ts) to confirm HTTP-verified pending + PAT both drain cleanly.
    const okBatch = await processGithubWebhookBatch({ workerDb, runtime: workerRuntime, broker: vault });
    expect(okBatch.patOk).toBe(1);

    // Manual taskLinkAdd on PAT binding sets hydrating = true and link_refresh hydrate job fills it from API.
    remoteItems.set('/repos/octo-org/core-api/issues/77', {
      number: 77,
      html_url: 'https://github.com/octo-org/core-api/issues/77',
      title: 'Hydrated PAT issue #77',
      state: 'open',
      user: { login: 'pat-author' },
      updated_at: '2026-11-27T02:05:00Z',
    });
    const manualAdd = await rpc(
      app,
      'projects/github/taskLinkAdd',
      owner,
      { projectId: projA, taskId: patTask, url: 'https://github.com/octo-org/core-api/issues/77', idempotencyKey: randomUUID() },
      orgA.slug,
    );
    expect(manualAdd.status).toBe(200);
    const createdLink = manualAdd.body?.link as { id: string; hydrating: boolean };
    expect(createdLink.hydrating).toBe(true);
    const hydratedRes = await runGithubHydrateJob(
      { runtime: workerRuntime, workerDb, broker: vault, github: githubClient },
      { mode: 'link_refresh', orgId: orgA.orgId, projectId: projA, taskId: patTask, linkId: createdLink.id, kind: 'issue', externalNumber: 77 },
    );
    expect(hydratedRes).toBe('hydrated');
    const linksView = await runtime.query<GithubTaskLinksQueryResult>('projects.github.task_links', { projectId: projA, taskId: patTask }, { actor: asUser(owner.userId), orgId: orgA.orgId });
    expect(linksView.links.find((l) => l.id === createdLink.id)).toMatchObject({ hydrating: false, externalTitle: 'Hydrated PAT issue #77', authorLogin: 'pat-author' });

    // PAT /issues/78 link targeting a PR upgrades the placeholder row in place without leaving a hydrating orphan.
    remoteItems.set('/repos/octo-org/core-api/issues/78', {
      number: 78,
      html_url: 'https://github.com/octo-org/core-api/issues/78',
      title: 'PAT PR via issues URL',
      state: 'open',
      pull_request: {},
      user: { login: 'pat-pr-author' },
      updated_at: '2026-11-27T02:06:00Z',
    });
    remoteItems.set('/repos/octo-org/core-api/pulls/78', {
      number: 78,
      html_url: 'https://github.com/octo-org/core-api/pull/78',
      title: 'PAT PR via issues URL',
      state: 'open',
      draft: false,
      merged: false,
      head: { ref: 'feat/pat-78' },
      user: { login: 'pat-pr-author' },
      updated_at: '2026-11-27T02:06:00Z',
    });
    const patPrAdd = await rpc(
      app,
      'projects/github/taskLinkAdd',
      owner,
      { projectId: projA, taskId: patTask, url: 'https://github.com/octo-org/core-api/issues/78', idempotencyKey: randomUUID() },
      orgA.slug,
    );
    expect(patPrAdd.status).toBe(200);
    const patPrPlaceholder = patPrAdd.body?.link as { id: string; kind: string; hydrating: boolean };
    expect(patPrPlaceholder).toMatchObject({ kind: 'issue', hydrating: true });
    expect(
      await runGithubHydrateJob(
        { runtime: workerRuntime, workerDb, broker: vault, github: githubClient },
        { mode: 'link_refresh', orgId: orgA.orgId, projectId: projA, taskId: patTask, linkId: patPrPlaceholder.id, kind: 'issue', externalNumber: 78 },
      ),
    ).toBe('hydrated');
    const patLinksAfterPr = await runtime.query<GithubTaskLinksQueryResult>('projects.github.task_links', { projectId: projA, taskId: patTask }, { actor: asUser(owner.userId), orgId: orgA.orgId });
    const links78 = patLinksAfterPr.links.filter((l) => l.externalNumber === 78);
    expect(links78).toHaveLength(1);
    expect(links78[0]).toMatchObject({
      id: patPrPlaceholder.id,
      kind: 'pull_request',
      externalUrl: 'https://github.com/octo-org/core-api/pull/78',
      branchName: 'feat/pat-78',
      hydrating: false,
    });

    // 10 wrong-HMAC notices auto-stop the PAT hook; rotation resets standing to active.
    for (let i = 0; i < 10; i += 1) {
      const badPost = await app.request(GITHUB_PAT_WEBHOOK_PATH.replace(':hookKey', hookKeyA), {
        method: 'POST',
        headers: {
          'x-github-event': 'issues',
          'x-github-delivery': `bad-${i}-${randomUUID()}`,
          'x-hub-signature-256': signGithubPayload(issuePayload, 'wrong-secret'),
        },
        body: issuePayload,
      });
      expect(badPost.status).toBe(202);
    }
    const rejectBatch = await processGithubWebhookBatch({ workerDb, runtime: workerRuntime, broker: vault });
    expect(rejectBatch.patRefused).toBe(10);

    const statusStopped = await runtime.query<GithubHookStatusResult>(
      'projects.github.hook_status',
      { connectionId: hookRow[0]!.channel_connection_id },
      { actor: asUser(owner.userId), orgId: orgA.orgId },
    );
    expect(statusStopped.standing).toBe('stopped');

    // 11th request after stop returns { queued: false } without storing a row.
    const eleventh = await app.request(GITHUB_PAT_WEBHOOK_PATH.replace(':hookKey', hookKeyA), {
      method: 'POST',
      headers: {
        'x-github-event': 'issues',
        'x-github-delivery': randomUUID(),
        'x-hub-signature-256': signGithubPayload(issuePayload, PAT_WEBHOOK_SECRET),
      },
      body: issuePayload,
    });
    expect(eleventh.status).toBe(202);
    expect(await eleventh.json()).toEqual({ queued: false });

    // Rotate PAT hook URL: old key fails 404, new key accepts; retrying with the same idempotencyKey rotates cleanly without 409 conflict.
    const rotateKey = randomUUID();
    const rotated = await rpc(app, 'projects/github/rotatePatHook', owner, { projectId: projA, idempotencyKey: rotateKey }, orgA.slug);
    expect(rotated.status).toBe(200);
    expect(rotated.body?.standing).toBe('active');
    const rotatedRetry = await rpc(app, 'projects/github/rotatePatHook', owner, { projectId: projA, idempotencyKey: rotateKey }, orgA.slug);
    expect(rotatedRetry.status).toBe(200);
    const newHookKey = String(rotatedRetry.body?.webhookUrl ?? '').split('/').pop()!;
    expect(newHookKey).not.toBe(hookKeyA);

    const oldAfterRotate = await app.request(GITHUB_PAT_WEBHOOK_PATH.replace(':hookKey', hookKeyA), {
      method: 'POST',
      headers: { 'x-github-event': 'issues', 'x-github-delivery': randomUUID(), 'x-hub-signature-256': signGithubPayload('{}', PAT_WEBHOOK_SECRET) },
      body: '{}',
    });
    expect(oldAfterRotate.status).toBe(404);

    // 10-minute sweep purges stale webhook rows in pending + notice.
    const staleNoticeBody = JSON.stringify({
      action: 'opened',
      repository: { id: 1001, full_name: 'octo-org/core-api' },
      issue: { number: 99, html_url: 'https://github.com/octo-org/core-api/issues/99', title: 'Stale', body: 'Stale pdpl.notice@github.example.test', state: 'open', updated_at: '2026-11-27T02:10:00Z' },
    });
    await app.request(GITHUB_PAT_WEBHOOK_PATH.replace(':hookKey', newHookKey), {
      method: 'POST',
      headers: { 'x-github-event': 'issues', 'x-github-delivery': randomUUID(), 'x-hub-signature-256': signGithubPayload(staleNoticeBody, PAT_WEBHOOK_SECRET) },
      body: staleNoticeBody,
    });
    const staleAppBody = JSON.stringify({ action: 'opened', installation: { id: 777 }, repository: { id: 1001, full_name: 'octo-org/core-api' }, issue: { number: 88, html_url: 'https://github.com/octo-org/core-api/issues/88', title: 'Pending', state: 'open' } });
    await app.request(GITHUB_WEBHOOK_PATH, {
      method: 'POST',
      headers: { 'x-github-event': 'issues', 'x-github-delivery': randomUUID(), 'x-hub-signature-256': signGithubPayload(staleAppBody, APP_WEBHOOK_SECRET) },
      body: staleAppBody,
    });
    // Park an aged copy before sweep, keeping a notice matching PDPL probe for erase test right after.
    await admin(async (c) => {
      await c.query(`UPDATE ludy_projects.github_webhook_pending SET received_at = now() - interval '11 minutes'`);
      await c.query(`UPDATE ludy_projects.github_webhook_notice SET received_at = now() - interval '11 minutes'`);
    });
    const sweptCount = await sweepGithubWebhooks(workerDb);
    expect(sweptCount).toBe(2);

    // PDPL find + erase across github_task_link AND un-swept github_webhook_notice body!
    const freshPiiNotice = JSON.stringify({
      action: 'opened',
      repository: { id: 1001, full_name: 'octo-org/core-api' },
      issue: { number: 56, html_url: 'https://github.com/octo-org/core-api/issues/56', title: 'PDPL pdpl.reporter@github.example.test', state: 'open' },
    });
    await app.request(GITHUB_PAT_WEBHOOK_PATH.replace(':hookKey', newHookKey), {
      method: 'POST',
      headers: { 'x-github-event': 'issues', 'x-github-delivery': randomUUID(), 'x-hub-signature-256': signGithubPayload(freshPiiNotice, PAT_WEBHOOK_SECRET) },
      body: freshPiiNotice,
    });
    const found = await runtime.execute<PersonalDataResult>(
      'kernel.personal_data.find',
      { value: 'pdpl.reporter@github.example.test' },
      { actor: asUser(owner.userId), orgId: orgA.orgId },
    );
    expect(found.matches.map((m) => m.column)).toEqual(
      expect.arrayContaining(['ludy_projects.github_task_link.external_title']),
    );
    const erased = await runtime.execute<PersonalDataErasure>(
      'kernel.personal_data.erase',
      { value: 'pdpl.reporter@github.example.test' },
      { actor: asMfa(owner.userId), orgId: orgA.orgId, idempotencyKey: randomUUID() },
    );
    expect(erased.erased.some((r) => r.column === 'ludy_projects.github_task_link.external_title' && r.rows >= 1)).toBe(true);
    expect(erased.erased.some((r) => r.column === 'ludy_projects.github_webhook_notice.body' && r.rows >= 1)).toBe(true);

    // Org export includes all three product GitHub tables.
    expect(EXPORT_TABLE_NAMES).toEqual(
      expect.arrayContaining(['projects.github_project_binding', 'projects.github_project_repo', 'projects.github_task_link']),
    );
    const exportedAt = new Date(Date.now() - 35 * DAY);
    const exportRecord = await runOrgExport({ runtime: workerRuntime, store, sealer, retentionDays: 40 }, orgA.orgId, { now: () => exportedAt });
    const bindingPart = exportRecord.parts.find((p) => p.table === 'projects.github_project_binding');
    expect(bindingPart).toBeDefined();
    const decryptedBinding = new TextDecoder().decode(
      sealer.open(await store.get(bindingPart!.key), exportAad(orgA.orgId, bindingPart!), 'aes-256-gcm'),
    );
    expect(decryptedBinding).toContain(projA);

    // Offboard & run cumulative org_purge on orgA; verify all 6 ludy_projects.github_* tables are emptied for orgA while orgB remains intact.
    await runtime.execute('kernel.org.offboard', { confirmSlug: orgA.slug }, { actor: asMfa(owner.userId), orgId: orgA.orgId });
    await admin(async (c) => {
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query(
        `UPDATE ludy_kernel.audit_event SET occurred_at = $1 WHERE org_id = $2 AND command IN ('kernel.org.offboard', 'kernel.org.export.record')`,
        [new Date(Date.now() - 32 * DAY), orgA.orgId],
      );
      await c.query('COMMIT');
    });
    const purged = await purgeOrg(workerRuntime, 30, { ref: orgA.orgId, reason: 'github-slice1-purge-test' });
    expect(purged).toMatchObject({ kind: 'purged', orgId: orgA.orgId });

    for (const tbl of [
      'ludy_projects.github_project_binding',
      'ludy_projects.github_project_repo',
      'ludy_projects.github_task_link',
      'ludy_projects.github_webhook_hook',
      'ludy_projects.github_webhook_notice',
      'ludy_projects.github_sync_delivery',
    ]) {
      const rem = await rows<{ n: string }>(`SELECT count(*)::text AS n FROM ${tbl} WHERE org_id = $1`, [orgA.orgId]);
      expect(rem[0]?.n, tbl).toBe('0');
    }
    const orgBBinding = await rows<{ n: string }>('SELECT count(*)::text AS n FROM ludy_projects.github_project_binding WHERE org_id = $1', [orgB.orgId]);
    expect(orgBBinding[0]?.n).toBe('1');
  });

  it('enforces B1 OAuth ownership + cross-org uniqueness, B2 ON DELETE SET NULL, B3 suspend/unsuspend/out-of-order, B4 off-app drop, B5 repo-id routing, and N6 broker gate', async () => {
    const orgOne = await createOrg(runtime, asUser(owner.userId), 'Công ty Bảo Mật Một');
    const orgTwo = await createOrg(runtime, asUser(outsider.userId), 'Công ty Bảo Mật Hai');

    const { projectId: proj1a } = await runtime.execute<{ projectId: string }>(
      'projects.project.create',
      { name: 'Security Project 1A' },
      { actor: asUser(owner.userId), orgId: orgOne.orgId, idempotencyKey: randomUUID() },
    );
    const { projectId: proj1b } = await runtime.execute<{ projectId: string }>(
      'projects.project.create',
      { name: 'Security Project 1B' },
      { actor: asUser(owner.userId), orgId: orgOne.orgId, idempotencyKey: randomUUID() },
    );
    const { projectId: proj2 } = await runtime.execute<{ projectId: string }>(
      'projects.project.create',
      { name: 'Security Project 2' },
      { actor: asUser(outsider.userId), orgId: orgTwo.orgId, idempotencyKey: randomUUID() },
    );

    // B1.1: tampered/wrong-project state, unowned installationId, 0 installations, >1 installations, and replay all fail fail-closed.
    const startA = await rpc(app, 'projects/github/appOAuthStart', owner, { projectId: proj1a }, orgOne.slug);
    expect(startA.status).toBe(200);
    const stateA = String(startA.body?.state ?? '');

    // Wrong projectId bound to stateA -> OAUTH_STATE_INVALID (consumed or rejected; issue fresh state for next check).
    const crossProj = await rpc(
      app,
      'projects/github/connectApp',
      owner,
      { projectId: proj1b, state: stateA, code: 'code-install-777', installationId: '777', idempotencyKey: randomUUID() },
      orgOne.slug,
    );
    expect(crossProj.status).toBe(400);

    // Replay of stateA on its original project after bad exchange? Let's consume stateA validly via unowned attempt:
    const startA2 = await rpc(app, 'projects/github/appOAuthStart', owner, { projectId: proj1a }, orgOne.slug);
    const stateA2 = String(startA2.body?.state ?? '');
    const callsBeforeForbidden = githubCalls.length;
    const unowned = await rpc(
      app,
      'projects/github/connectApp',
      owner,
      { projectId: proj1a, state: stateA2, code: 'code-other-user', installationId: '888', idempotencyKey: randomUUID() },
      orgOne.slug,
    );
    expect(unowned.status).toBe(403);
    expect(unowned.body?.code).toBe('GITHUB_INSTALLATION_NOT_AUTHORIZED');
    // Verify stateA2 was consumed before exchange so replay cannot reuse it.
    const callsAtForbidden = githubCalls.length;
    const replayA2 = await rpc(
      app,
      'projects/github/connectApp',
      owner,
      { projectId: proj1a, state: stateA2, code: 'code-install-888', installationId: '888', idempotencyKey: randomUUID() },
      orgOne.slug,
    );
    expect(replayA2.status).toBe(409);
    expect(replayA2.body?.code).toBe('OAUTH_STATE_USED');
    expect(githubCalls.length).toBe(callsAtForbidden);
    expect(callsAtForbidden).toBeGreaterThan(callsBeforeForbidden);

    // 0 installations and >1 installations when installationId is omitted:
    const startEmpty = await rpc(app, 'projects/github/appOAuthStart', owner, { projectId: proj1a }, orgOne.slug);
    const noInst = await rpc(
      app,
      'projects/github/connectApp',
      owner,
      { projectId: proj1a, state: String(startEmpty.body?.state ?? ''), code: 'code-empty-user', idempotencyKey: randomUUID() },
      orgOne.slug,
    );
    expect(noInst.status).toBe(422);
    expect(noInst.body?.code).toBe('GITHUB_NO_INSTALLATIONS');

    const startMulti = await rpc(app, 'projects/github/appOAuthStart', owner, { projectId: proj1a }, orgOne.slug);
    const multiInst = await rpc(
      app,
      'projects/github/connectApp',
      owner,
      { projectId: proj1a, state: String(startMulti.body?.state ?? ''), code: 'code-multi-user', idempotencyKey: randomUUID() },
      orgOne.slug,
    );
    expect(multiInst.status).toBe(422);
    expect(multiInst.body?.code).toBe('GITHUB_MULTIPLE_INSTALLATIONS');

    // Connect uniquely via omitted installationId (single installation 888 owned by code-install-888):
    const startAuto = await rpc(app, 'projects/github/appOAuthStart', owner, { projectId: proj1a }, orgOne.slug);
    const connAuto = await rpc(
      app,
      'projects/github/connectApp',
      owner,
      { projectId: proj1a, state: String(startAuto.body?.state ?? ''), code: 'code-install-888', taskKeyPrefix: 'SEC', idempotencyKey: randomUUID() },
      orgOne.slug,
    );
    expect(connAuto.status).toBe(200);
    expect(String(connAuto.body?.connectionId ?? '')).not.toBe('');

    // B1.2: Another org cannot claim installation 888 while orgOne holds an active/non-revoked connection -> 409 CHANNEL_ACCOUNT_TAKEN.
    const startOrgTwo = await rpc(app, 'projects/github/appOAuthStart', outsider, { projectId: proj2 }, orgTwo.slug);
    const takenErr = await rpc(
      app,
      'projects/github/connectApp',
      outsider,
      { projectId: proj2, state: String(startOrgTwo.body?.state ?? ''), code: 'code-install-888', installationId: '888', idempotencyKey: randomUUID() },
      orgTwo.slug,
    );
    expect(takenErr.status).toBe(409);
    expect(takenErr.body?.code).toBe('CHANNEL_ACCOUNT_TAKEN');

    // Bind repo 1001 with an outdated repo_full_name ('octo-org/legacy-name') for B5 test.
    const bound = await rpc(
      app,
      'projects/github/repoBind',
      owner,
      { projectId: proj1a, githubRepoId: '1001', repoFullName: 'octo-org/legacy-name', defaultBranch: 'main', webhookConfigured: true, idempotencyKey: randomUUID() },
      orgOne.slug,
    );
    expect(bound.status).toBe(200);

    // Create task & custom columns (init defaults first so column.create and status validation succeed) to verify B2 ON DELETE SET NULL without FK error.
    const defaults = await runtime.execute<{ columns: Array<{ id: string; taskStatus: string }> }>(
      'projects.column.init_defaults',
      { projectId: proj1a, language: 'en' },
      { actor: asUser(owner.userId), orgId: orgOne.orgId, idempotencyKey: randomUUID() },
    );
    const defProg = defaults.columns.find((c) => c.taskStatus === 'in_progress')!;
    const defRev = defaults.columns.find((c) => c.taskStatus === 'in_review')!;
    const defDone = defaults.columns.find((c) => c.taskStatus === 'done')!;
    const colProg = await runtime.execute<{ column: { id: string } }>(
      'projects.column.create',
      { projectId: proj1a, name: 'QA Progress', taskStatus: 'in_progress' },
      { actor: asUser(owner.userId), orgId: orgOne.orgId, idempotencyKey: randomUUID() },
    );
    const colRev = await runtime.execute<{ column: { id: string } }>(
      'projects.column.create',
      { projectId: proj1a, name: 'QA Review', taskStatus: 'in_review' },
      { actor: asUser(owner.userId), orgId: orgOne.orgId, idempotencyKey: randomUUID() },
    );
    const colDone = await runtime.execute<{ column: { id: string } }>(
      'projects.column.create',
      { projectId: proj1a, name: 'QA Done', taskStatus: 'done' },
      { actor: asUser(owner.userId), orgId: orgOne.orgId, idempotencyKey: randomUUID() },
    );
    const saveCols = await rpc(
      app,
      'projects/github/bindingSave',
      owner,
      {
        projectId: proj1a,
        channelConnectionId: String(connAuto.body?.connectionId ?? ''),
        githubEnabled: true,
        inboundColInProgress: colProg.column.id,
        inboundColInReview: colRev.column.id,
        inboundColDone: colDone.column.id,
        idempotencyKey: randomUUID(),
      },
      orgOne.slug,
    );
    expect(saveCols.status).toBe(200);

    const { taskId: taskSec } = await runtime.execute<{ taskId: string }>(
      'projects.task.create',
      { projectId: proj1a, title: 'Fix renamed repo sync', assigneePositionId: null },
      { actor: asUser(owner.userId), orgId: orgOne.orgId, idempotencyKey: randomUUID() },
    );

    // B5: Webhook payload arrives with RENAMED repository full_name ('octo-org/renamed-core') and same githubRepoId (1001) -> still routes & syncs!
    const renamedPrBody = JSON.stringify({
      action: 'opened',
      installation: { id: 888 },
      repository: { id: 1001, full_name: 'octo-org/renamed-core' },
      pull_request: {
        number: 301,
        title: 'Resolve SEC-1 after repo rename',
        body: 'Closes SEC-1',
        state: 'open',
        merged: false,
        draft: false,
        html_url: 'https://github.com/octo-org/renamed-core/pull/301',
        updated_at: '2027-02-01T00:00:00Z',
        user: { login: 'dev-alice' },
        head: { ref: 'feat/SEC-1' },
      },
    });
    const renamedRes = await app.request(GITHUB_WEBHOOK_PATH, {
      method: 'POST',
      headers: {
        'x-github-event': 'pull_request',
        'x-github-delivery': randomUUID(),
        'x-hub-signature-256': signGithubPayload(renamedPrBody, APP_WEBHOOK_SECRET),
      },
      body: renamedPrBody,
    });
    expect(renamedRes.status).toBe(202);
    await processGithubWebhookBatch({
      workerDb,
      runtime: workerRuntime,
      broker: vault,
      appWebhookSecrets: [APP_WEBHOOK_SECRET],
    });
    const secLinks = await rows<{ task_id: string }>(
      'SELECT task_id FROM ludy_projects.github_task_link WHERE org_id = $1 AND project_id = $2',
      [orgOne.orgId, proj1a],
    );
    expect(secLinks).toEqual([{ task_id: taskSec }]);

    // B5: Verify github_pat_org_bindings enforces p_org_id on a real github_pat connection.
    const { projectId: projPatScope } = await runtime.execute<{ projectId: string }>(
      'projects.project.create',
      { name: 'PAT Org Scope Check' },
      { actor: asUser(owner.userId), orgId: orgOne.orgId, idempotencyKey: randomUUID() },
    );
    const connectPatScope = await rpc(
      app,
      'projects/github/connectPat',
      owner,
      {
        projectId: projPatScope,
        accessToken: 'test-pat-scope-token-value',
        webhookSecret: PAT_WEBHOOK_SECRET,
        idempotencyKey: randomUUID(),
      },
      orgOne.slug,
    );
    expect(connectPatScope.status).toBe(200);
    const patConnIdScope = String(connectPatScope.body?.connectionId ?? '');
    const bindPatScope = await rpc(
      app,
      'projects/github/repoBind',
      owner,
      { projectId: projPatScope, githubRepoId: '1001', repoFullName: 'octo-org/core-api', defaultBranch: 'main', idempotencyKey: randomUUID() },
      orgOne.slug,
    );
    expect(bindPatScope.status).toBe(200);
    const { rows: rightOrgPatBindings } = await sql<{ org_id: string }>`
      SELECT org_id
      FROM ludy_projects.github_pat_org_bindings(${orgOne.orgId}::uuid, ${patConnIdScope}::uuid, 1001::bigint)`.execute(workerDb);
    expect(rightOrgPatBindings).toHaveLength(1);
    const { rows: wrongOrgPatBindings } = await sql<{ org_id: string }>`
      SELECT org_id
      FROM ludy_projects.github_pat_org_bindings(${orgTwo.orgId}::uuid, ${patConnIdScope}::uuid, 1001::bigint)`.execute(workerDb);
    expect(wrongOrgPatBindings).toEqual([]);

    // B2: Delete custom columns -> inbound_col_* columns become NULL cleanly; delete kernel.task -> github_sync_delivery.task_id becomes NULL cleanly.
    await runtime.execute(
      'projects.column.delete',
      { projectId: proj1a, columnId: colProg.column.id, fallbackColumnId: defProg.id },
      { actor: asUser(owner.userId), orgId: orgOne.orgId, idempotencyKey: randomUUID() },
    );
    await runtime.execute(
      'projects.column.delete',
      { projectId: proj1a, columnId: colRev.column.id, fallbackColumnId: defRev.id },
      { actor: asUser(owner.userId), orgId: orgOne.orgId, idempotencyKey: randomUUID() },
    );
    await runtime.execute(
      'projects.column.delete',
      { projectId: proj1a, columnId: colDone.column.id, fallbackColumnId: defDone.id },
      { actor: asUser(owner.userId), orgId: orgOne.orgId, idempotencyKey: randomUUID() },
    );
    const colsAfterDel = await rows<{ inbound_col_in_progress: string | null; inbound_col_in_review: string | null; inbound_col_done: string | null }>(
      'SELECT inbound_col_in_progress, inbound_col_in_review, inbound_col_done FROM ludy_projects.github_project_binding WHERE org_id = $1 AND project_id = $2',
      [orgOne.orgId, proj1a],
    );
    expect(colsAfterDel[0]).toEqual({ inbound_col_in_progress: null, inbound_col_in_review: null, inbound_col_done: null });

    await admin((c) => c.query('DELETE FROM ludy_kernel.task WHERE org_id = $1 AND id = $2', [orgOne.orgId, taskSec]));
    const delivAfterTaskDel = await rows<{ task_id: string | null }>(
      'SELECT task_id FROM ludy_projects.github_sync_delivery WHERE org_id = $1 AND project_id = $2',
      [orgOne.orgId, proj1a],
    );
    expect(delivAfterTaskDel.length).toBeGreaterThan(0);
    expect(delivAfterTaskDel.every((r) => r.task_id === null)).toBe(true);

    // B4: When projects app is turned off for orgOne, queued App webhook does not record delivery rows or call GitHub API.
    await runtime.execute('kernel.org.set_app', { module: 'projects', enabled: false }, { actor: asUser(owner.userId), orgId: orgOne.orgId, idempotencyKey: randomUUID() });
    const countBeforeOff = await rows<{ n: string }>('SELECT count(*)::text AS n FROM ludy_projects.github_sync_delivery WHERE org_id = $1', [orgOne.orgId]);
    const callsBeforeOff = githubCalls.length;
    const offBody = JSON.stringify({
      action: 'opened',
      installation: { id: 888 },
      repository: { id: 1001, full_name: 'octo-org/renamed-core' },
      issue: { number: 399, html_url: 'https://github.com/octo-org/renamed-core/issues/399', title: 'Off-app drop test SEC-1', state: 'open' },
    });
    await app.request(GITHUB_WEBHOOK_PATH, {
      method: 'POST',
      headers: { 'x-github-event': 'issues', 'x-github-delivery': randomUUID(), 'x-hub-signature-256': signGithubPayload(offBody, APP_WEBHOOK_SECRET) },
      body: offBody,
    });
    await processGithubWebhookBatch({
      workerDb,
      runtime: workerRuntime,
      broker: vault,
      appWebhookSecrets: [APP_WEBHOOK_SECRET],
    });
    const countAfterOff = await rows<{ n: string }>('SELECT count(*)::text AS n FROM ludy_projects.github_sync_delivery WHERE org_id = $1', [orgOne.orgId]);
    expect(countAfterOff[0]?.n).toBe(countBeforeOff[0]?.n);
    expect(githubCalls.length).toBe(callsBeforeOff);
    await runtime.execute('kernel.org.set_app', { module: 'projects', enabled: true }, { actor: asUser(owner.userId), orgId: orgOne.orgId, idempotencyKey: randomUUID() });

    // B3: suspend -> unsuspend -> deleted -> out-of-order unsuspend ignored.
    const suspendPayload = JSON.stringify({ action: 'suspend', installation: { id: 888, account: { id: 9888, login: 'octo-org-2' } } });
    await app.request(GITHUB_WEBHOOK_PATH, {
      method: 'POST',
      headers: { 'x-github-event': 'installation', 'x-github-delivery': randomUUID(), 'x-hub-signature-256': signGithubPayload(suspendPayload, APP_WEBHOOK_SECRET) },
      body: suspendPayload,
    });
    await processGithubWebhookBatch({ workerDb, runtime: workerRuntime, broker: vault, appWebhookSecrets: [APP_WEBHOOK_SECRET] });
    const afterSuspend = await rows<{ paused_reason: string | null }>('SELECT paused_reason FROM ludy_projects.github_project_binding WHERE org_id = $1 AND project_id = $2', [orgOne.orgId, proj1a]);
    expect(afterSuspend[0]?.paused_reason).toBe('installation_suspended');

    const unsuspendPayload = JSON.stringify({ action: 'unsuspend', installation: { id: 888, account: { id: 9888, login: 'octo-org-2' } } });
    await app.request(GITHUB_WEBHOOK_PATH, {
      method: 'POST',
      headers: { 'x-github-event': 'installation', 'x-github-delivery': randomUUID(), 'x-hub-signature-256': signGithubPayload(unsuspendPayload, APP_WEBHOOK_SECRET) },
      body: unsuspendPayload,
    });
    await processGithubWebhookBatch({ workerDb, runtime: workerRuntime, broker: vault, appWebhookSecrets: [APP_WEBHOOK_SECRET] });
    const afterUnsuspend = await rows<{ paused_reason: string | null; paused_at: string | null }>('SELECT paused_reason, paused_at FROM ludy_projects.github_project_binding WHERE org_id = $1 AND project_id = $2', [orgOne.orgId, proj1a]);
    expect(afterUnsuspend[0]).toEqual({ paused_reason: null, paused_at: null });

    // B3: installation_repositories.removed deletes removed repo via system installation_sync.
    await rpc(
      app,
      'projects/github/repoBind',
      owner,
      { projectId: proj1a, githubRepoId: '1002', repoFullName: 'octo-org/web-app', defaultBranch: 'main', webhookConfigured: true, idempotencyKey: randomUUID() },
      orgOne.slug,
    );
    const repoRemovedPayload = JSON.stringify({
      action: 'removed',
      installation: { id: 888 },
      repositories_removed: [{ id: 1002, full_name: 'octo-org/web-app' }],
    });
    await app.request(GITHUB_WEBHOOK_PATH, {
      method: 'POST',
      headers: { 'x-github-event': 'installation_repositories', 'x-github-delivery': randomUUID(), 'x-hub-signature-256': signGithubPayload(repoRemovedPayload, APP_WEBHOOK_SECRET) },
      body: repoRemovedPayload,
    });
    await processGithubWebhookBatch({ workerDb, runtime: workerRuntime, broker: vault, appWebhookSecrets: [APP_WEBHOOK_SECRET] });
    const reposAfterRemove = await rows<{ github_repo_id: string }>('SELECT github_repo_id::text FROM ludy_projects.github_project_repo WHERE org_id = $1 AND project_id = $2 ORDER BY github_repo_id', [orgOne.orgId, proj1a]);
    expect(reposAfterRemove).toEqual([{ github_repo_id: '1001' }]);

    const delPayload = JSON.stringify({ action: 'deleted', installation: { id: 888, account: { id: 9888, login: 'octo-org-2' } } });
    await app.request(GITHUB_WEBHOOK_PATH, {
      method: 'POST',
      headers: { 'x-github-event': 'installation', 'x-github-delivery': randomUUID(), 'x-hub-signature-256': signGithubPayload(delPayload, APP_WEBHOOK_SECRET) },
      body: delPayload,
    });
    await processGithubWebhookBatch({ workerDb, runtime: workerRuntime, broker: vault, appWebhookSecrets: [APP_WEBHOOK_SECRET] });

    // Out-of-order unsuspend arriving after deleted MUST keep connection revoked and binding disabled/paused.
    await app.request(GITHUB_WEBHOOK_PATH, {
      method: 'POST',
      headers: { 'x-github-event': 'installation', 'x-github-delivery': randomUUID(), 'x-hub-signature-256': signGithubPayload(unsuspendPayload, APP_WEBHOOK_SECRET) },
      body: unsuspendPayload,
    });
    await processGithubWebhookBatch({ workerDb, runtime: workerRuntime, broker: vault, appWebhookSecrets: [APP_WEBHOOK_SECRET] });
    const afterOutOfOrder = await rows<{ github_enabled: boolean; paused_reason: string | null; conn_status: string }>(
      `SELECT b.github_enabled, b.paused_reason, c.status AS conn_status
       FROM ludy_projects.github_project_binding b
       JOIN ludy_kernel.channel_connection c ON c.org_id = b.org_id AND c.id = b.channel_connection_id
       WHERE b.org_id = $1 AND b.project_id = $2`,
      [orgOne.orgId, proj1a],
    );
    expect(afterOutOfOrder[0]).toEqual({ github_enabled: false, paused_reason: 'installation_deleted', conn_status: 'revoked' });

    // Audit and outbox contain installation_sync + channel disconnection after deletion.
    const auditSynced = await rows<{ n: string }>(
      `SELECT count(*)::text AS n FROM ludy_kernel.audit_event WHERE org_id = $1 AND command = 'projects.github.installation_sync'`,
      [orgOne.orgId],
    );
    expect(Number(auditSynced[0]?.n ?? 0)).toBeGreaterThanOrEqual(3);

    // Once revoked in orgOne, orgTwo can now connect installation 888 cleanly.
    const retryOrgTwo = await rpc(app, 'projects/github/appOAuthStart', outsider, { projectId: proj2 }, orgTwo.slug);
    const okOrgTwo = await rpc(
      app,
      'projects/github/connectApp',
      outsider,
      { projectId: proj2, state: String(retryOrgTwo.body?.state ?? ''), code: 'code-install-888', installationId: '888', idempotencyKey: randomUUID() },
      orgTwo.slug,
    );
    expect(okOrgTwo.status).toBe(200);

    // N6: Without credential broker (broker.id === 'none'), GITHUB_PAT_WEBHOOK_PATH is not registered -> 404.
    const noBrokerConfig = loadConfig({
      DATABASE_URL: 'postgres://localhost/x',
      AUTH_JWT_SECRET: SECRET,
      AUTH_ISSUER: ISSUER,
      AUTH_SESSION_CHECK: 'off',
      PUBLIC_URL: 'http://localhost:8080',
      MIGRATIONS_DIR: MIGRATIONS,
      WEB_DIST: '/nonexistent',
    });
    const appNoBroker = createHttpApp({
      config: noBrokerConfig,
      runtime,
      store: { put: async () => {}, get: async () => Buffer.alloc(0), delete: async () => {}, exists: async () => false } as unknown as BlobStore,
      authenticate: createAuthenticator(noBrokerConfig, appDb),
      pool: appPool,
      aiEnabled: false,
      channels: { broker: { id: 'none' } as unknown as CredentialBroker, sandbox: false, publicUrl: 'http://localhost:8080' },
      githubWebhook: { appWebhookSecret: APP_WEBHOOK_SECRET },
    });
    const patNoBrokerRes = await appNoBroker.request(GITHUB_PAT_WEBHOOK_PATH.replace(':hookKey', 'A'.repeat(32)), {
      method: 'POST',
      headers: { 'x-github-event': 'ping', 'x-github-delivery': randomUUID(), 'x-hub-signature-256': 'sha256=' + '0'.repeat(64) },
      body: '{}',
    });
    expect(patNoBrokerRes.status).toBe(404);
  });
});

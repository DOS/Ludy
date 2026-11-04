// SPDX-License-Identifier: AGPL-3.0-only
// Ads on PostgreSQL 17 (issue #2217, ADR-0040, plan docs/plan/ads.md): an owner connects a sandbox ad account through the
// API, the worker's sync reads it with the credential the API sealed and stores the figures in the account's own currency
// and time zone, a day inside the revision window is rewritten in place and a final day is never read again, the summary
// adds them up in decimal, the roles, the org and the legal-entity scope are checked, a failed sync and a rate limit are
// recorded, and nothing of the credential reaches an answer, an audit row or an event. The pure rules are unit-tested in
// modules/ads/test/domain.test.ts and the adapter in packages/ad-platform/test/sandbox.test.ts.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run creates and drops its own database.
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';
import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AdPlatformError, MetaAdsPlatform, SandboxAdWriter, adLaunchWriters, adPausers, adPlatforms, launchWriterOf, platformUserHash, revokerOf, sandboxWriteLogin, type AdPlatform, type LaunchWriter, type sandboxAdPlatform } from '@crove/ad-platform';
import { ConnectorError, type Fetch, type OAuthConnector } from '@crove/channel';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { decideApproval, kernelCommands, kernelQueries } from '@crove/kernel';
import { zTodayItems, type AdAccountView, type AdsSummary, type AdsSyncRunView, type TodayItem } from '@crove/kernel-contract';
import { CredentialVault, DomainError, mintContextToken, parseVaultKey, Runtime, sha256Hex, type BlobStore } from '@crove/kernel-runtime';
import { addDays, addMonths, adsCommands, adsQueries, todayIn } from '@crove/mod-ads';
import { createAuthenticator } from '../src/auth.ts';
import { acceptAdsDeletion, adsDeletionStatus, runAdsDeletions } from '../src/ads-deletion.ts';
import { runAdsLaunch } from '../src/ads-launch.ts';
import { runAdsPause } from '../src/ads-pause.ts';
import { runAdsRevoke } from '../src/ads-revoke.ts';
import { acceptMetaDeletion, metaDeletionStatus } from '../src/meta-deletion.ts';
import { adsDue, pruneAdsRuns, runAdsSync } from '../src/ads-sync.ts';
import { loadConfig } from '../src/config.ts';
import { RateLimiter } from '../src/rate-limit.ts';
import { createHttpApp } from '../src/http.ts';
import { createSessionStatusSource } from '../src/sessions.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const SECRET = 'test-only-jwt-secret-for-ads-0123456789-abcdefghij';
const ISSUER = 'crove-auth';

class MemoryStore implements BlobStore {
  private readonly blobs = new Map<string, Uint8Array>();
  async put(key: string, bytes: Uint8Array) {
    this.blobs.set(key, bytes);
    return `content:${sha256Hex(bytes)}`;
  }
  async get(key: string) {
    const b = this.blobs.get(key);
    if (!b) throw new Error('missing blob');
    return b;
  }
  async delete(key: string) {
    this.blobs.delete(key);
  }
}

interface Account {
  subject: string;
  email: string;
  session: string;
  userId: string;
}

const suite = ADMIN ? describe : describe.skip;
const SYSTEM = { type: 'system' as const, component: 'ads' };
const DAY_MS = 86_400_000;

// The OAuth connector of Meta ads the API holds in these tests, made of fixed answers: Meta's dialog and token exchange are
// not reached from a test. A grant covers two ad accounts.
const META_GRANT = { write: false, user: '7001', lastSpendAllowed: null as boolean | null };
const META_CONNECTOR: OAuthConnector = {
  provider: 'meta_ads',
  pkce: false,
  authorizeUrl: ({ state, redirectUri }) => `https://www.facebook.com/v24.0/dialog/oauth?state=${state}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=ads_read`,
  exchange: async (input) => {
    META_GRANT.lastSpendAllowed = input.spendScopesAllowed ?? false;
    // The grant of a person whose token also holds ads_management: the connector refuses it unless the org's switch for running ads is
    // on (the API says so), as MetaAdsConnector does, and then records the full set.
    if (META_GRANT.write && !input.spendScopesAllowed) throw new ConnectorError('denied', 'the token holds ads_management', 'WRITE_PERMISSION_GRANTED');
    // The second account's token also holds a Pages permission, which is accepted and shown.
    return ['act_9001', 'act_9002'].map((id) => ({
      provider: 'meta_ads' as const,
      externalAccountId: id,
      displayName: `Meta ${id}`,
      scopes: [...(id === 'act_9002' ? ['ads_read', 'pages_manage_posts'] : ['ads_read']), ...(META_GRANT.write ? ['ads_management'] : [])],
      expiresAt: new Date(Date.now() + 60 * DAY_MS),
      secret: JSON.stringify({ accessToken: 'EAAB-grant-token' }),
      // The person who granted it, as the connector hands it on: a keyed hash, never the Meta user id.
      grantedByHash: platformUserHash('meta-app-secret', META_GRANT.user),
    }));
  },
};

// The write connection's OAuth connector (ADR-0043, W0b): Meta's dialog asks for ads_management too, and the token holds it.
const META_WRITE_CONNECTOR: OAuthConnector = {
  provider: 'metawrite_ads',
  pkce: false,
  authorizeUrl: ({ state, redirectUri }) => `https://www.facebook.com/v24.0/dialog/oauth?state=${state}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=ads_read,ads_management`,
  exchange: async () =>
    ['act_9001', 'act_9002'].map((id) => ({
      provider: 'metawrite_ads' as const,
      externalAccountId: id,
      displayName: `Meta ${id}`,
      scopes: ['ads_read', 'ads_management'],
      expiresAt: new Date(Date.now() + 60 * DAY_MS),
      secret: JSON.stringify({ accessToken: 'EAAB-write-token' }),
      grantedByHash: platformUserHash('meta-app-secret', META_GRANT.user),
    })),
};

suite('ads on PostgreSQL (#2217)', () => {
  const dbName = `crove_test_ads_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  const workerPools: pg.Pool[] = [];
  let app: ReturnType<typeof createHttpApp>;
  let appConfig: ReturnType<typeof loadConfig>;
  let appDb: Db;
  let api: Runtime;
  let worker: Runtime;
  let workerDb: Db;
  let vault: CredentialVault;
  // The clock the sandbox platform and the worker's sync read (#2548). A test that compares what a sync stored with a "today" of its own freezes it at one instant
  // (`freeze`), so the platform, the sync and the test all agree on the day of the account's zone, whatever the hour the suite runs at (a wall clock can roll over
  // in the zone between the sync and the test's own reading); every other test runs on the wall clock. The API's own commands read the runtime's clock, which
  // a test cannot move: what they decide from "today" is compared in the same instant by the test that reads it, with no sync between.
  let frozen: Date | null = null;
  const clock = (): Date => frozen ?? new Date();
  const freeze = (at: Date = new Date()): Date => {
    frozen = at;
    return at;
  };
  afterEach(() => {
    frozen = null;
  });
  const sandbox = adPlatforms({ sandbox: true, now: clock });
  const owner: Account = { subject: randomUUID(), email: 'owner@ads.test', session: randomUUID(), userId: '' };
  const adminAccount: Account = { subject: randomUUID(), email: 'admin@ads.test', session: randomUUID(), userId: '' };
  const member: Account = { subject: randomUUID(), email: 'member@ads.test', session: randomUUID(), userId: '' };
  const viewer: Account = { subject: randomUUID(), email: 'viewer@ads.test', session: randomUUID(), userId: '' };
  const accountant: Account = { subject: randomUUID(), email: 'accountant@ads.test', session: randomUUID(), userId: '' };
  const outsider: Account = { subject: randomUUID(), email: 'outsider@ads.test', session: randomUUID(), userId: '' };
  let slug = '';
  let orgId = '';
  let otherSlug = '';
  let otherOrgId = '';
  let branch = '';
  // The accounts made for the tests, by name.
  const accounts = new Map<string, { connectionId: string; adAccountId: string }>();

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

  async function rpc(path: string, token: string, input: unknown, org: string | null = slug) {
    const response = await app.request(`/api/rpc/${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(org ? { 'x-crove-org': org } : {}) },
      body: JSON.stringify(input === undefined ? {} : { json: input }),
    });
    const body = (await response.json().catch(() => null)) as ({ json?: unknown } & Record<string, unknown>) | null;
    return { status: response.status, body: (body && 'json' in body ? body.json : body) as any };
  }

  const ok = async (path: string, who: Account, input: unknown, org: string | null = slug) => {
    const r = await rpc(path, await tokenFor(who), input, org);
    expect(r.status, `${path}: ${JSON.stringify(r.body)}`).toBe(200);
    return r.body;
  };

  // Connects a sandbox ad account through the API (the secret is sealed there) and runs its first sync as the worker.
  async function connect(name: string, options: { currency?: 'VND' | 'USD'; legalEntityId?: string } = {}) {
    const made = (await ok('ads/connectSandbox', owner, { displayName: name, idempotencyKey: randomUUID(), ...options })) as { connectionId: string; adAccountId: string };
    accounts.set(name, made);
    return made;
  }

  const sync = (connectionId: string, platforms: Readonly<Record<string, AdPlatform>> = sandbox, org = orgId) =>
    runAdsSync({ runtime: worker, broker: vault, platforms, now: clock }, { orgId: org, connectionId });
  // The owner as the API's runtime sees a signed-in person: with the session the token carries.
  const asOwner = () => ({ type: 'user' as const, userId: owner.userId, aal: 'aal1' as const, sessionId: owner.session });
  // The audit rows of ads.account.erase that tests other than the deletion callback's own made (that test counts its own).
  let eraseAuditsBefore = 0;
  const row = async <T extends pg.QueryResultRow>(sql: string, params: unknown[] = []) => admin(async (c) => (await c.query<T>(sql, params)).rows);
  const view = async (who: Account, id: string): Promise<AdAccountView | undefined> => ((await ok('ads/accounts', who, undefined)) as AdAccountView[]).find((a) => a.id === id);

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
    const appUrl = new URL(adminUrl);
    appUrl.username = 'crove_app';
    appUrl.password = 'test-app-pw';
    pool = createPool({ connectionString: appUrl.toString(), max: 4 });
    const db: Db = createDb(pool);
    const registered = { commands: [...kernelCommands, ...adsCommands], queries: [...kernelQueries({ inboundDomain: null }), ...adsQueries] };
    api = new Runtime(db, { manifests: TEST_MANIFESTS, sessions: createSessionStatusSource('off'), stepUp: 'required' }).register(registered);
    vault = new CredentialVault([parseVaultKey(randomBytes(32).toString('base64'))]);
    const config = loadConfig({ DATABASE_URL: appUrl.toString(), AUTH_JWT_SECRET: SECRET, AUTH_ISSUER: ISSUER, AUTH_SESSION_CHECK: 'off', MIGRATIONS_DIR: MIGRATIONS, WEB_DIST: '/nonexistent' });
    app = createHttpApp({
      config,
      runtime: api,
      store: new MemoryStore(),
      authenticate: createAuthenticator(config, db),
      pool,
      aiEnabled: false,
      channels: { broker: vault, sandbox: true, adsPlatforms: { ...sandbox, ...adPlatforms({ sandbox: false, meta: { appSecret: 'meta-app-secret' } }) }, connectors: { meta_ads: META_CONNECTOR, metawrite_ads: META_WRITE_CONNECTOR }, publicUrl: 'https://ludy.example.test' },
      adsDeletion: { appSecret: 'meta-app-secret' },
    });
    appConfig = config;
    appDb = db;
    const workerUrl = new URL(adminUrl);
    workerUrl.username = 'crove_worker';
    workerUrl.password = 'test-worker-pw';
    const workerPool = createPool({ connectionString: workerUrl.toString(), max: 2 });
    workerPools.push(workerPool);
    workerDb = createDb(workerPool);
    worker = new Runtime(workerDb, { manifests: TEST_MANIFESTS }).register(registered);

    for (const who of [owner, adminAccount, member, viewer, accountant, outsider]) {
      const me = await rpc('me/get', await tokenFor(who), undefined, null);
      expect(me.status).toBe(200);
      who.userId = String(me.body?.userId);
    }
    const created = await rpc('org/create', await tokenFor(owner), { name: 'Công ty Quảng cáo', idempotencyKey: randomUUID() }, null);
    slug = String(created.body?.slug);
    orgId = String(created.body?.orgId);
    for (const [who, role] of [
      [adminAccount, 'admin'],
      [member, 'member'],
      [viewer, 'viewer'],
      [accountant, 'member'],
    ] as const) {
      const invite = await rpc('org/invite', await tokenFor(owner, { mfa: true }), { email: who.email, role });
      expect(invite.status).toBe(200);
      expect((await rpc('invites/accept', await tokenFor(who), { token: String(invite.body?.acceptPath).split('#')[1] }, null)).status).toBe(200);
    }
    const other = await rpc('org/create', await tokenFor(outsider), { name: 'Công ty khác', idempotencyKey: randomUUID() }, null);
    otherSlug = String(other.body?.slug);
    otherOrgId = String(other.body?.orgId);
    // A branch, and a member limited to it (an external accountant of the branch only).
    branch = randomUUID();
    await admin(async (c) => {
      await c.query(`INSERT INTO crove_kernel.legal_entity (org_id, id, name, kind, created_by) VALUES ($1, $2, 'Chi nhánh quảng cáo', 'branch', $3)`, [orgId, branch, owner.userId]);
      await c.query(`INSERT INTO crove_kernel.role_assignment (org_id, id, user_id, role_key, legal_entity_id, granted_by) VALUES ($1, $2, $3, 'external_accountant', $4, $5)`, [
        orgId,
        randomUUID(),
        accountant.userId,
        branch,
        owner.userId,
      ]);
    });
  }, 300_000);

  afterAll(async () => {
    for (const p of workerPools) await p.end();
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('links a connected sandbox account for an owner, seals its secret, and leaves it out of the Social channels', async () => {
    const made = await connect('Quảng cáo chính');
    const account = await view(owner, made.adAccountId);
    expect(account).toMatchObject({
      id: made.adAccountId,
      connectionId: made.connectionId,
      connectionStatus: 'active',
      provider: 'sandbox_ads',
      name: 'Quảng cáo chính',
      currency: null,
      timeZone: null,
      expenseAccountCode: null,
      resultKind: null,
      resultKinds: ['purchase', 'lead'],
      settledThrough: null,
      syncedThrough: null,
    });
    // 13 months of history, as the owner agreed (#2214 Q4).
    const today = todayIn('UTC', new Date());
    expect((account?.backfillFrom as string) <= today).toBe(true);
    // Exactly 13 calendar months back, clamped to a shorter month: a count of days varies with the month and the clock.
    expect(account?.backfillFrom).toBe(addMonths(today, -13));
    // Sealed: a credential row, and no token anywhere an answer or a trail could carry it.
    const sealed = await row<{ n: string }>(`SELECT count(*)::text AS n FROM crove_kernel.credential WHERE org_id = $1 AND connection_id = $2`, [orgId, made.connectionId]);
    expect(sealed[0]?.n).toBe('1');
    const leaks = await row<{ n: string }>(
      `SELECT (SELECT count(*) FROM crove_kernel.audit_event WHERE org_id = $1 AND detail::text LIKE '%sbx_%')
            + (SELECT count(*) FROM crove_kernel.outbox_event WHERE org_id = $1 AND payload::text LIKE '%sbx_%') AS n`,
      [orgId],
    );
    expect(Number(leaks[0]?.n)).toBe(0);
    // The Social channel list does not show an ad account's connection.
    const channels = (await ok('channels/list', owner, {})) as Array<{ provider: string }>;
    expect(channels.map((c) => c.provider)).not.toContain('sandbox_ads');
    // Linking it again is the same account.
    const again = await api.execute<{ adAccountId: string; linked: boolean }>('ads.account.link', { connectionId: made.connectionId }, { actor: asOwner(), orgId });
    expect(again).toEqual({ adAccountId: made.adAccountId, linked: false });
  });

  it('leaves no connection behind when the link is refused, and a retried connect is the same account', async () => {
    const live = async () => Number((await row<{ n: string }>(`SELECT count(*)::text AS n FROM crove_kernel.channel_connection WHERE org_id = $1 AND provider = 'sandbox_ads' AND status <> 'revoked'`, [orgId]))[0]?.n);
    const before = await live();
    // An entity the caller cannot use: refused after the connection was made, which is then disconnected.
    const refused = await rpc('ads/connectSandbox', await tokenFor(owner), { displayName: 'Sai pháp nhân', legalEntityId: randomUUID(), idempotencyKey: randomUUID() });
    expect(refused.status).toBe(403);
    expect(await live()).toBe(before);
    const credentials = await row<{ n: string }>(`SELECT count(*)::text AS n FROM crove_kernel.credential c JOIN crove_kernel.channel_connection k ON k.org_id = c.org_id AND k.id = c.connection_id WHERE c.org_id = $1 AND k.provider = 'sandbox_ads' AND k.status = 'revoked'`, [orgId]);
    expect(credentials[0]?.n).toBe('0');
    // The same request twice is one account and one connection, whatever the second seal is.
    const key = randomUUID();
    const first = (await ok('ads/connectSandbox', owner, { displayName: 'Hai lần', idempotencyKey: key })) as { connectionId: string; adAccountId: string };
    const second = (await ok('ads/connectSandbox', owner, { displayName: 'Hai lần', idempotencyKey: key })) as { connectionId: string; adAccountId: string };
    expect(second).toEqual(first);
    expect(await live()).toBe(before + 1);
    // A retry whose link is then refused (the same key with another entity) leaves the account's own connection alone.
    const clash = await rpc('ads/connectSandbox', await tokenFor(owner), { displayName: 'Hai lần', legalEntityId: randomUUID(), idempotencyKey: key });
    expect(clash.status).toBeGreaterThanOrEqual(400);
    expect(await live()).toBe(before + 1);
    accounts.set('Hai lần', first);
  });

  it('refuses a member, a viewer and another org the connection, and a connection that is not an ad account', async () => {
    for (const who of [member, viewer]) {
      const r = await rpc('ads/connectSandbox', await tokenFor(who), { displayName: 'Thử', idempotencyKey: randomUUID() });
      expect(r.status, who.email).toBe(403);
    }
    const r = await rpc('ads/connectSandbox', await tokenFor(outsider), { displayName: 'Thử', idempotencyKey: randomUUID() }, otherSlug);
    // The outsider owns another org and may connect there; what they cannot do is reach this org's accounts.
    expect(r.status).toBe(200);
    const mine = ((await ok('ads/accounts', owner, undefined)) as AdAccountView[]).map((a) => a.name);
    expect(mine).not.toContain('Thử');
    const stranger = await rpc('ads/accounts', await tokenFor(outsider), undefined, slug);
    expect(stranger.status).toBeGreaterThanOrEqual(400);
    // A Social channel is not an ad account.
    const conn = await rpc('channels/connectSandbox', await tokenFor(owner), { displayName: 'Kênh', key: randomUUID() });
    expect(conn.status).toBe(200);
    await expect(
      api.execute('ads.account.link', { connectionId: String(conn.body?.connectionId) }, { actor: asOwner(), orgId }),
    ).rejects.toMatchObject({ code: 'ADS_CONNECTION_NOT_FOUND' });
  });

  it("reads the credential in the worker and stores 13 months of the account's days in its own currency and time zone", async () => {
    const at = freeze();
    const { connectionId, adAccountId } = await connect('Đồng');
    const done = await sync(connectionId);
    expect(done.rows).toBeGreaterThan(1000);
    expect(done.slices).toBeGreaterThanOrEqual(13);
    const account = await view(owner, adAccountId);
    expect(account).toMatchObject({ currency: 'VND', timeZone: 'Asia/Ho_Chi_Minh', name: 'Đồng', lastErrorKind: null, nextRunAt: null });
    const today = todayIn('Asia/Ho_Chi_Minh', at);
    expect(account?.syncedThrough).toBe(today);
    // Days before today less the three-day revision window are final.
    expect(account?.settledThrough).toBe(new Date(Date.parse(today) - 4 * DAY_MS).toISOString().slice(0, 10));
    const days = await row<{ day: string; currency: string; level: string; settled: boolean }>(
      `SELECT day::text, currency, level, settled_at IS NOT NULL AS settled FROM crove_ads.ad_spend_day WHERE org_id = $1 AND ad_account_id = $2 AND level = 'account' ORDER BY day`,
      [orgId, adAccountId],
    );
    expect(days.length).toBeGreaterThan(300);
    expect(days.every((d) => d.currency === 'VND')).toBe(true);
    expect((days[0]?.day as string) >= (account?.backfillFrom as string)).toBe(true);
    expect((days.at(-1)?.day as string) <= today).toBe(true);
    for (const d of days) expect(d.settled, d.day).toBe(d.day <= (account?.settledThrough as string));
    const runs = (await ok('ads/syncRuns', owner, { adAccountId })) as AdsSyncRunView[];
    expect(runs.length).toBeGreaterThanOrEqual(13);
    expect(runs.every((r) => r.status === 'ok')).toBe(true);
  });

  it('rewrites a day inside the revision window in place, and never reads a final day again', async () => {
    const { connectionId, adAccountId } = await connect('Đọc lại');
    await sync(connectionId);
    const before = await row<{ id: string; day: string; spend: string; fetched_at: Date; settled: boolean }>(
      `SELECT id, day::text, spend::text, fetched_at, settled_at IS NOT NULL AS settled FROM crove_ads.ad_spend_day WHERE org_id = $1 AND ad_account_id = $2 AND level = 'account' ORDER BY day`,
      [orgId, adAccountId],
    );
    // A second sync asks the platform for the unsettled days only.
    const ranges: Array<{ from: string; to: string }> = [];
    const spy: Readonly<Record<string, AdPlatform>> = {
      sandbox_ads: {
        ...(sandbox.sandbox_ads as AdPlatform),
        readDaily: (secret, id, range) => {
          ranges.push(range);
          return (sandbox.sandbox_ads as AdPlatform).readDaily(secret, id, range);
        },
      },
    };
    const target = await row<{ settled_through: string }>(`SELECT settled_through::text FROM crove_ads.ad_account WHERE org_id = $1 AND id = $2`, [orgId, adAccountId]);
    await sync(connectionId, spy);
    const settledThrough = target[0]?.settled_through as string;
    expect(ranges).toHaveLength(1);
    expect(ranges[0]?.from).toBe(new Date(Date.parse(settledThrough) + DAY_MS).toISOString().slice(0, 10));
    const after = await row<{ id: string; day: string; spend: string; fetched_at: Date; settled: boolean }>(
      `SELECT id, day::text, spend::text, fetched_at, settled_at IS NOT NULL AS settled FROM crove_ads.ad_spend_day WHERE org_id = $1 AND ad_account_id = $2 AND level = 'account' ORDER BY day`,
      [orgId, adAccountId],
    );
    expect(after.map((r) => r.day)).toEqual(before.map((r) => r.day));
    // The same rows (in place), final days untouched, the others read again.
    expect(after.map((r) => r.id)).toEqual(before.map((r) => r.id));
    for (const [i, r] of after.entries()) {
      const was = before[i] as (typeof before)[number];
      if (r.day <= settledThrough) expect(r.fetched_at.getTime(), r.day).toBe(was.fetched_at.getTime());
      else expect(r.fetched_at.getTime(), r.day).toBeGreaterThan(was.fetched_at.getTime());
    }
  });

  // The days of the account's figures that are not final yet, newest first.
  const unsettledDays = async (adAccountId: string) =>
    (await row<{ day: string }>(`SELECT day::text FROM crove_ads.ad_spend_day WHERE org_id = $1 AND ad_account_id = $2 AND level = 'account' AND settled_at IS NULL ORDER BY day DESC`, [orgId, adAccountId])).map((r) => r.day);
  const daysCount = async (adAccountId: string, day: string) => Number((await row<{ n: string }>(`SELECT count(*)::text AS n FROM crove_ads.ad_spend_day WHERE org_id = $1 AND ad_account_id = $2 AND day = $3`, [orgId, adAccountId, day]))[0]?.n);

  // The instants the platform's day and the account's day can disagree around (#2548): inside the window the flake was seen in (14:04 to 14:13 UTC, 21:04 to
  // 21:13 in Ho Chi Minh City), the second before and after that zone's midnight (17:00 UTC), and the turn of the UTC date. Dated two days back from the real clock's UTC
  // date: the account's history (13 months back from the real clock) reaches them, and none is ahead of the real day, which the API's own record command
  // refuses (it judges a window against the runtime's clock, which a test cannot move).
  const pinDay = addDays(new Date().toISOString().slice(0, 10), -2);
  const PINS: Array<[string, string]> = [
    ['14:05Z', `${pinDay}T14:05:00Z`],
    ['16:59:59Z, a second before 17:00 UTC', `${pinDay}T16:59:59Z`],
    ['17:00:00Z, the zone midnight', `${pinDay}T17:00:00Z`],
    ['17:00:01Z', `${pinDay}T17:00:01Z`],
    ['23:59:59Z', `${pinDay}T23:59:59Z`],
    ['00:00:00Z, the next UTC date', `${addDays(pinDay, 1)}T00:00:00Z`],
  ];

  it.each(PINS)('removes a day of the window the platform no longer reports, and keeps a final one, with the clock at %s', async (label, at) => {
    freeze(new Date(at));
    const { connectionId, adAccountId } = await connect(`Bớt ngày ${label}`);
    await sync(connectionId);
    const today = todayIn('Asia/Ho_Chi_Minh', clock());
    // The days that are not final are today (in the account's zone) and the three before it, as many of them as the platform reported a campaign on. The sandbox's day
    // is the account's: nothing is stored after it, and the oldest of them is the last day of the revision window.
    const window = await unsettledDays(adAccountId);
    expect(window.length).toBeGreaterThan(0);
    expect(window.every((d) => d <= today && d >= addDays(today, -3)), window.join(',')).toBe(true);
    const silent: Readonly<Record<string, AdPlatform>> = { sandbox_ads: { ...(sandbox.sandbox_ads as AdPlatform), readDaily: async () => [] } };
    await sync(connectionId, silent);
    expect(await unsettledDays(adAccountId)).toEqual([]);
    for (const day of window) expect(await daysCount(adAccountId, day), day).toBe(0);
    // A final day is never in the window, so an empty answer leaves it.
    const final = (await row<{ day: string }>(`SELECT day::text FROM crove_ads.ad_spend_day WHERE org_id = $1 AND ad_account_id = $2 AND settled_at IS NOT NULL LIMIT 1`, [orgId, adAccountId]))[0]?.day as string;
    expect(await daysCount(adAccountId, final)).toBeGreaterThan(0);
  });

  // The sandbox gives each campaign no row on about one day in seven, by a seed of the connection's random token, so now and then a whole day of the window has no
  // figure at all (the flake of #2548 was a test that expected yesterday to have one). A platform that reported nothing for a day is simulated here: the days
  // that were reported are the ones removed when the platform goes silent, and none is expected that was not.
  it('removes the days of the window that were reported when the platform goes silent, though no campaign ran on one of them', async () => {
    const at = freeze();
    const { connectionId, adAccountId } = await connect('Một ngày không có số liệu');
    const today = todayIn('Asia/Ho_Chi_Minh', at);
    const yesterday = addDays(today, -1);
    const gap: Readonly<Record<string, AdPlatform>> = {
      sandbox_ads: { ...(sandbox.sandbox_ads as AdPlatform), readDaily: async (secret, id, range) => (await (sandbox.sandbox_ads as AdPlatform).readDaily(secret, id, range)).filter((r) => r.day !== yesterday) },
    };
    await sync(connectionId, gap);
    expect(await daysCount(adAccountId, yesterday)).toBe(0);
    const window = await unsettledDays(adAccountId);
    expect(window.length).toBeGreaterThan(0);
    expect(window).not.toContain(yesterday);
    await sync(connectionId, { sandbox_ads: { ...(sandbox.sandbox_ads as AdPlatform), readDaily: async () => [] } });
    expect(await unsettledDays(adAccountId)).toEqual([]);
  });

  it('adds the days up in decimal, by month and campaign, and works the cost per result from the chosen action', async () => {
    const { connectionId, adAccountId } = await connect('Tổng hợp');
    await sync(connectionId);
    const from = new Date(Date.now() - 60 * DAY_MS).toISOString().slice(0, 10);
    const to = todayIn('Asia/Ho_Chi_Minh', new Date());
    // No result chosen: no results and no cost per result.
    const plain = (await ok('ads/summary', member, { adAccountId, from, to })) as AdsSummary;
    expect(plain).toMatchObject({ currency: 'VND', resultKind: null, total: { results: null, costPerResult: null } });
    // The owner chooses purchases.
    await ok('ads/configure', owner, { adAccountId, resultKind: 'purchase', expenseAccountCode: '6421', idempotencyKey: randomUUID() });
    const summary = (await ok('ads/summary', viewer, { adAccountId, from, to })) as AdsSummary;
    expect(summary.resultKind).toBe('purchase');
    const sums = await row<{ spend: string; impressions: string; clicks: string; purchases: string }>(
      `SELECT sum(spend)::text AS spend, sum(impressions)::text AS impressions, sum(clicks)::text AS clicks, sum((results ->> 'purchase')::numeric)::text AS purchases
       FROM crove_ads.ad_spend_day WHERE org_id = $1 AND ad_account_id = $2 AND level = 'account' AND day BETWEEN $3 AND $4`,
      [orgId, adAccountId, from, to],
    );
    expect(summary.total.spend).toBe(sums[0]?.spend);
    expect(summary.total.impressions).toBe(Number(sums[0]?.impressions));
    expect(summary.total.clicks).toBe(Number(sums[0]?.clicks));
    expect(summary.total.results).toBe(sums[0]?.purchases);
    // Dong have no decimals, so the cost per result is rounded to a whole dong: half a dong either way is exact (vitest's
    // toBeCloseTo(.., 0) refuses a difference of exactly 0.5, which the figures of some days give).
    expect(Math.abs(Number(summary.total.costPerResult) - Number(sums[0]?.spend) / Number(sums[0]?.purchases))).toBeLessThanOrEqual(0.5);
    // Months add up to the total, campaigns to the total too (the account row is their sum), and days to the total.
    const spendOf = (items: Array<{ spend: string }>) => items.reduce((n, i) => n + Number(i.spend), 0);
    expect(spendOf(summary.months)).toBe(Number(summary.total.spend));
    expect(spendOf(summary.campaigns)).toBe(Number(summary.total.spend));
    expect(spendOf(summary.days)).toBe(Number(summary.total.spend));
    expect(summary.campaigns.map((c) => c.name).sort()).toEqual(['Khuyến mãi mùa hè', 'Nhận diện thương hiệu', 'Tin nhắn Messenger']);
    // Largest spend first.
    expect(summary.campaigns.map((c) => Number(c.spend))).toEqual(summary.campaigns.map((c) => Number(c.spend)).sort((a, b) => b - a));
    expect(summary.days.some((d) => d.settled) && summary.days.some((d) => !d.settled)).toBe(true);
    expect(summary.days.every((d) => d.reach === null || Number.isInteger(d.reach))).toBe(true);
    // An account's range is bounded, and an unknown account is not found.
    expect((await rpc('ads/summary', await tokenFor(owner), { adAccountId, from: '2024-01-01', to })).status).toBe(422);
    expect((await rpc('ads/summary', await tokenFor(owner), { adAccountId: randomUUID(), from, to })).status).toBe(404);
  });

  it('keeps dollars to the cent and never converts them', async () => {
    const { connectionId, adAccountId } = await connect('Đô la', { currency: 'USD' });
    await sync(connectionId);
    expect(await view(owner, adAccountId)).toMatchObject({ currency: 'USD', timeZone: 'America/Los_Angeles' });
    await ok('ads/configure', owner, { adAccountId, resultKind: 'lead', idempotencyKey: randomUUID() });
    const summary = (await ok('ads/summary', owner, { adAccountId, from: new Date(Date.now() - 30 * DAY_MS).toISOString().slice(0, 10), to: todayIn('America/Los_Angeles', new Date()) })) as AdsSummary;
    expect(summary.currency).toBe('USD');
    expect(summary.total.spend).toMatch(/^\d+\.\d{2}$/);
    expect(summary.total.costPerResult).toMatch(/^\d+\.\d{2}$/);
    expect(summary.months.every((m) => /^\d+\.\d{2}$/.test(m.spend))).toBe(true);
  });

  it('lets owners and admins configure, members refresh at most once a minute, and nobody else do either', async () => {
    const { adAccountId } = accounts.get('Tổng hợp') as { adAccountId: string };
    for (const who of [member, viewer]) {
      expect((await rpc('ads/configure', await tokenFor(who), { adAccountId, resultKind: 'lead', idempotencyKey: randomUUID() })).status, who.email).toBe(403);
    }
    expect((await rpc('ads/requestSync', await tokenFor(viewer), { adAccountId, idempotencyKey: randomUUID() })).status).toBe(403);
    await ok('ads/requestSync', member, { adAccountId, idempotencyKey: randomUUID() });
    const second = await rpc('ads/requestSync', await tokenFor(owner), { adAccountId, idempotencyKey: randomUUID() });
    expect(second.status).toBe(429);
    expect(second.body?.code).toBe('ADS_SYNC_TOO_SOON');
    // The asked-for refresh is an event for the worker, naming the connection and not a credential.
    const events = await row<{ payload: Record<string, unknown> }>(`SELECT payload FROM crove_kernel.outbox_event WHERE org_id = $1 AND type = 'ads.sync.requested'`, [orgId]);
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(Object.keys(events[0]?.payload as object).sort()).toEqual(['ad_account_id', 'connection_id']);
    // A bad expense account code is refused before the database.
    expect((await rpc('ads/configure', await tokenFor(owner), { adAccountId, expenseAccountCode: 'abc', idempotencyKey: randomUUID() })).status).toBe(400);
    await ok('ads/configure', owner, { adAccountId, expenseAccountCode: null, idempotencyKey: randomUUID() });
    expect((await view(owner, adAccountId))?.expenseAccountCode).toBeNull();
  });

  it('reads an account in the entity the caller reads, and no other', async () => {
    const own = await connect('Chi nhánh', { legalEntityId: branch });
    const main = accounts.get('Đồng') as { adAccountId: string };
    expect((await view(owner, own.adAccountId))?.legalEntityId).toBe(branch);
    // The accountant limited to the branch sees the branch account and not the head office's.
    const seen = ((await ok('ads/accounts', accountant, undefined)) as AdAccountView[]).map((a) => a.id);
    expect(seen).toEqual([own.adAccountId]);
    const from = new Date(Date.now() - 30 * DAY_MS).toISOString().slice(0, 10);
    expect((await rpc('ads/summary', await tokenFor(accountant), { adAccountId: main.adAccountId, from, to: from })).status).toBe(404);
    // Nor may they link or configure into an entity outside their scope.
    expect((await rpc('ads/configure', await tokenFor(accountant), { adAccountId: own.adAccountId, resultKind: 'lead', idempotencyKey: randomUUID() })).status).toBe(403);
    // Moving an account to another entity moves its history with it.
    await sync(own.connectionId);
    const entities = async (account: string) =>
      row<{ n: string }>(`SELECT count(*)::text AS n FROM crove_ads.ad_spend_day WHERE org_id = $1 AND ad_account_id = $2 AND legal_entity_id = $3`, [orgId, account, branch]);
    expect(Number((await entities(own.adAccountId))[0]?.n)).toBeGreaterThan(0);
    const defaultEntity = (await row<{ id: string }>(`SELECT id FROM crove_kernel.legal_entity WHERE org_id = $1 AND is_default`, [orgId]))[0]?.id as string;
    await ok('ads/configure', owner, { adAccountId: own.adAccountId, legalEntityId: defaultEntity, idempotencyKey: randomUUID() });
    expect(Number((await entities(own.adAccountId))[0]?.n)).toBe(0);
    const moved = await row<{ n: string }>(`SELECT count(*)::text AS n FROM crove_ads.ad_spend_day WHERE org_id = $1 AND ad_account_id = $2 AND legal_entity_id = $3`, [orgId, own.adAccountId, defaultEntity]);
    expect(Number(moved[0]?.n)).toBeGreaterThan(0);
    expect(((await ok('ads/accounts', accountant, undefined)) as AdAccountView[])).toEqual([]);
  });

  it('records a failed sync, holds the next one back after a rate limit, and expires a connection the platform refused', async () => {
    const { connectionId, adAccountId } = await connect('Hay lỗi');
    const failing = (error: AdPlatformError): Readonly<Record<string, AdPlatform>> => ({
      sandbox_ads: {
        ...(sandbox.sandbox_ads as AdPlatform),
        readDaily: async () => {
          throw error;
        },
      },
    });
    // A passing failure is left to the job's retry (it throws), and is recorded too.
    await expect(sync(connectionId, failing(new AdPlatformError('transient', '2')))).rejects.toBeInstanceOf(AdPlatformError);
    let account = await view(owner, adAccountId);
    expect(account?.lastErrorKind).toBe('transient');
    expect(account?.nextRunAt).toBeNull();
    // A rate limit holds the next run back to the time the platform named.
    const retryAt = new Date(Date.now() + 2 * 3_600_000);
    await sync(connectionId, failing(new AdPlatformError('rate_limited', '80000', retryAt)));
    account = await view(owner, adAccountId);
    expect(account?.lastErrorKind).toBe('rate_limited');
    expect(Math.abs(Date.parse(account?.nextRunAt as string) - retryAt.getTime())).toBeLessThan(1000);
    // The hourly sweep leaves it alone until then, and so does a refresh asked for by hand or a job already queued.
    const due = await adsDue(workerDb, null);
    expect(due.some((d) => d.connectionId === connectionId)).toBe(false);
    expect(due.every((d) => d.provider === 'sandbox_ads')).toBe(true);
    const held = await rpc('ads/requestSync', await tokenFor(owner), { adAccountId, idempotencyKey: randomUUID() });
    expect(held.status).toBe(429);
    expect(held.body?.code).toBe('ADS_SYNC_ON_HOLD');
    const reads: string[] = [];
    const spy = { sandbox_ads: { ...(sandbox.sandbox_ads as AdPlatform), readDaily: async () => { reads.push('read'); return []; } } };
    expect(await sync(connectionId, spy)).toEqual({ rows: 0, slices: 0 });
    expect(reads).toEqual([]);
    const runs = (await ok('ads/syncRuns', owner, { adAccountId })) as AdsSyncRunView[];
    expect(runs[0]).toMatchObject({ status: 'failed', errorKind: 'rate_limited', errorCode: '80000' });
    // The hold passes (here by hand: the owner of the database moves it).
    await row(`UPDATE crove_ads.ad_account SET next_run_at = NULL WHERE org_id = $1 AND id = $2`, [orgId, adAccountId]);
    // A refused token ends the connection: expired until an owner reconnects it, and no longer swept.
    await sync(connectionId, failing(new AdPlatformError('token_expired', '190')));
    account = await view(owner, adAccountId);
    expect(account).toMatchObject({ connectionStatus: 'expired', lastErrorKind: 'token_expired' });
    expect((await adsDue(workerDb, null)).some((d) => d.connectionId === connectionId)).toBe(false);
    // The expired account is not refreshed on request.
    const refused = await rpc('ads/requestSync', await tokenFor(owner), { adAccountId, idempotencyKey: randomUUID() });
    expect(refused.status).toBe(422);
    // Whatever an unclassified error carried, only a fixed code is kept.
    const other = await connect('Lỗi lạ');
    await expect(sync(other.connectionId, { sandbox_ads: { ...(sandbox.sandbox_ads as AdPlatform), readDaily: async () => { throw new Error('boom sbx_secret'); } } })).rejects.toThrow('boom');
    const failed = await row<{ error_code: string }>(`SELECT error_code FROM crove_ads.ad_sync_run WHERE org_id = $1 AND ad_account_id = $2 AND status = 'failed'`, [orgId, other.adAccountId]);
    expect(failed).toEqual([{ error_code: 'ADAPTER_ERROR' }]);
    // A refusal that would come every hour is recorded on the account and shown, not thrown into the dead letters.
    const odd = await connect('Dữ liệu lạ');
    const twice: Readonly<Record<string, AdPlatform>> = {
      sandbox_ads: {
        ...(sandbox.sandbox_ads as AdPlatform),
        readDaily: async (secret, id, range) => {
          const rows = await (sandbox.sandbox_ads as AdPlatform).readDaily(secret, id, range);
          return [...rows, ...rows.slice(0, 1)];
        },
      },
    };
    expect(await sync(odd.connectionId, twice)).toEqual({ rows: 0, slices: 0 });
    expect(await view(owner, odd.adAccountId)).toMatchObject({ connectionStatus: 'active', lastErrorKind: 'bad_request' });
    const refusal = await row<{ error_code: string }>(`SELECT error_code FROM crove_ads.ad_sync_run WHERE org_id = $1 AND ad_account_id = $2 AND status = 'failed'`, [orgId, odd.adAccountId]);
    expect(refusal).toEqual([{ error_code: 'ADS_ROWS_INVALID' }]);
    // The database failing in a way that passes (here a deadlock the runtime names RETRY) is a passing failure: recorded as
    // such, and left to the job's retry, not shown as a refusal that would come every hour.
    const busy = await connect('Cơ sở dữ liệu bận');
    const deadlocked = new Proxy(worker, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target) as unknown;
        if (prop === 'execute') {
          return (name: string, input: unknown, options: unknown) =>
            name === 'ads.sync.record' ? Promise.reject(new DomainError('RETRY', 409, 'deadlock')) : (target.execute as (...args: unknown[]) => Promise<unknown>).call(target, name, input, options);
        }
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await expect(runAdsSync({ runtime: deadlocked, broker: vault, platforms: sandbox }, { orgId, connectionId: busy.connectionId })).rejects.toMatchObject({ code: 'RETRY' });
    expect(await view(owner, busy.adAccountId)).toMatchObject({ connectionStatus: 'active', lastErrorKind: 'transient' });
  });

  it('reads an answer with too many rows in halves of its days', async () => {
    const at = freeze();
    const { connectionId, adAccountId } = await connect('Rất nhiều chiến dịch');
    // 40 days of history, so the first read is a 31-day slice and a shorter one: from the UTC date of the frozen instant, which the expectation below counts from too.
    const first = addDays(at.toISOString().slice(0, 10), -40);
    await row(`UPDATE crove_ads.ad_account SET backfill_from = $3 WHERE org_id = $1 AND id = $2`, [orgId, adAccountId, first]);
    const dense: Readonly<Record<string, AdPlatform>> = {
      sandbox_ads: {
        ...(sandbox.sandbox_ads as AdPlatform),
        readDaily: async (_secret, id, range) => {
          const rows: Awaited<ReturnType<AdPlatform['readDaily']>> = [];
          for (let ms = Date.parse(`${range.from}T00:00:00Z`); ms <= Date.parse(`${range.to}T00:00:00Z`); ms += DAY_MS) {
            const day = new Date(ms).toISOString().slice(0, 10);
            rows.push({ level: 'account', externalObjectId: id, objectName: 'a', day, spend: '800', impressions: 1, clicks: 1, reach: null, results: {} });
            for (let c = 0; c < 800; c++) rows.push({ level: 'campaign', externalObjectId: `c${c}`, objectName: `c${c}`, day, spend: '1', impressions: 1, clicks: 1, reach: null, results: {} });
          }
          return rows;
        },
      },
    };
    const done = await sync(connectionId, dense);
    // The 31-day slice (24,831 rows) was read as two halves, so more parts than the two slices.
    expect(done.slices).toBeGreaterThan(2);
    const stored = await row<{ days: string; n: string }>(
      `SELECT count(DISTINCT day)::text AS days, count(*)::text AS n FROM crove_ads.ad_spend_day WHERE org_id = $1 AND ad_account_id = $2`,
      [orgId, adAccountId],
    );
    // From the first day of history (40 days back, by the UTC date) to today in the account's zone, on the frozen clock the sync read.
    const expectedDays = Math.round((Date.parse(todayIn('Asia/Ho_Chi_Minh', at)) - Date.parse(first)) / DAY_MS) + 1;
    expect(Number(stored[0]?.days)).toBe(expectedDays);
    expect(Number(stored[0]?.n)).toBe(expectedDays * 801);
    expect(done.rows).toBe(expectedDays * 801);
  }, 120_000);

  it('keeps the history of an account connected again after a disconnect, on the same row', async () => {
    const { connectionId, adAccountId } = await connect('Nối lại');
    await sync(connectionId);
    const before = await row<{ n: string }>(`SELECT count(*)::text AS n FROM crove_ads.ad_spend_day WHERE org_id = $1 AND ad_account_id = $2`, [orgId, adAccountId]);
    expect((await rpc('channels/disconnect', await tokenFor(owner), { connectionId, idempotencyKey: randomUUID() })).status).toBe(200);
    expect(await view(owner, adAccountId)).toMatchObject({ connectionStatus: 'revoked' });
    // A revoked connection is not synced, and the sweep skips it.
    expect(await sync(connectionId)).toEqual({ rows: 0, slices: 0 });
    expect((await adsDue(workerDb, null)).some((d) => d.connectionId === connectionId)).toBe(false);
    // The same platform account connected again: a new connection takes over the row and its history. The sandbox makes
    // a fresh account each time, so this is done with the same account id by sealing its secret again.
    const secret = (await row<{ id: string }>(`SELECT external_account_id AS id FROM crove_ads.ad_account WHERE org_id = $1 AND id = $2`, [orgId, adAccountId]))[0]?.id as string;
    const login = JSON.stringify({ accessToken: `sbx_${'a'.repeat(43)}`, currency: 'VND', key: 'reconnect-key' });
    const sealed = vault.seal(login, { orgId, provider: 'sandbox_ads', externalAccountId: secret });
    const reconnected = await api.execute<{ connectionId: string }>(
      'kernel.channel.connect',
      { provider: 'sandbox_ads', externalAccountId: secret, displayName: 'Nối lại', scopes: [], expiresAt: null, credential: { keyId: sealed.keyId, envelope: sealed.envelope.toString('base64') } },
      { actor: asOwner(), orgId },
    );
    expect(reconnected.connectionId).not.toBe(connectionId);
    const linked = await api.execute<{ adAccountId: string; linked: boolean }>('ads.account.link', { connectionId: reconnected.connectionId }, { actor: asOwner(), orgId });
    expect(linked).toEqual({ adAccountId, linked: false });
    expect(await view(owner, adAccountId)).toMatchObject({ connectionId: reconnected.connectionId, connectionStatus: 'active' });
    const after = await row<{ n: string }>(`SELECT count(*)::text AS n FROM crove_ads.ad_spend_day WHERE org_id = $1 AND ad_account_id = $2`, [orgId, adAccountId]);
    expect(after[0]?.n).toBe(before[0]?.n);
  });

  it('checks what a platform hands the record command, and lets only the system run it', async () => {
    const { adAccountId } = accounts.get('Đồng') as { adAccountId: string };
    const today = todayIn('Asia/Ho_Chi_Minh', new Date());
    const details = { currency: 'VND', timeZone: 'Asia/Ho_Chi_Minh' };
    const base = { externalObjectId: 'c1', objectName: 'x', spend: '1000', impressions: 1, clicks: 1, reach: null, results: {} };
    const record = (input: Record<string, unknown>) => worker.execute('ads.sync.record', { adAccountId, details, window: { from: today, to: today }, settleBefore: null, rows: [], ...input }, { actor: SYSTEM, orgId });
    await expect(record({ rows: [{ level: 'campaign', day: today, ...base }, { level: 'campaign', day: today, ...base }] })).rejects.toMatchObject({ code: 'ADS_ROWS_INVALID' });
    const yesterday = new Date(Date.parse(today) - DAY_MS).toISOString().slice(0, 10);
    await expect(record({ rows: [{ level: 'campaign', day: yesterday, ...base }] })).rejects.toMatchObject({ code: 'ADS_ROWS_INVALID' });
    await expect(record({ window: { from: today, to: new Date(Date.parse(today) + 2 * DAY_MS).toISOString().slice(0, 10) } })).rejects.toMatchObject({ code: 'ADS_ROWS_INVALID' });
    await expect(record({ settleBefore: new Date(Date.parse(today) + 5 * DAY_MS).toISOString().slice(0, 10) })).rejects.toMatchObject({ code: 'ADS_ROWS_INVALID' });
    await expect(record({ details: { ...details, currency: 'USD' } })).rejects.toMatchObject({ code: 'ADS_CURRENCY_CHANGED' });
    await expect(record({ window: { from: '2020-01-01', to: today } })).rejects.toMatchObject({ code: 'ADS_ROWS_INVALID' });
    await expect(record({ rows: [{ level: 'campaign', day: today, ...base, spend: '-1' }] })).rejects.toMatchObject({ status: 422 });
    await expect(record({ rows: [{ level: 'campaign', day: today, ...base, spend: '1e3' }] })).rejects.toMatchObject({ status: 422 });
    await expect(record({ rows: [{ level: 'campaign', day: today, ...base, impressions: 1.5 }] })).rejects.toMatchObject({ status: 422 });
    // An account-level row names the account itself.
    await expect(record({ rows: [{ level: 'account', day: today, ...base }] })).rejects.toMatchObject({ code: 'ADS_ROWS_INVALID' });
    // A final day is never rewritten, even by a window that covers it.
    const finalDay = (await row<{ day: string; spend: string; external: string }>(
      `SELECT d.day::text, d.spend::text, a.external_account_id AS external FROM crove_ads.ad_spend_day d JOIN crove_ads.ad_account a ON a.org_id = d.org_id AND a.id = d.ad_account_id
       WHERE d.org_id = $1 AND d.ad_account_id = $2 AND d.level = 'account' AND d.settled_at IS NOT NULL ORDER BY d.day DESC LIMIT 1`,
      [orgId, adAccountId],
    ))[0] as { day: string; spend: string; external: string };
    await record({ window: { from: finalDay.day, to: finalDay.day }, rows: [{ level: 'account', day: finalDay.day, ...base, externalObjectId: finalDay.external, spend: '1' }] });
    const kept = await row<{ spend: string }>(`SELECT spend::text FROM crove_ads.ad_spend_day WHERE org_id = $1 AND ad_account_id = $2 AND level = 'account' AND day = $3`, [orgId, adAccountId, finalDay.day]);
    expect(kept).toEqual([{ spend: finalDay.spend }]);
    // A person cannot run it, whatever their role.
    await expect(api.execute('ads.sync.record', { adAccountId, details, window: { from: today, to: today }, settleBefore: null, rows: [] }, { actor: asOwner(), orgId })).rejects.toMatchObject({ status: 403 });
    await expect(api.execute('ads.sync.record_failure', { adAccountId, errorKind: 'unknown' }, { actor: asOwner(), orgId })).rejects.toMatchObject({ status: 403 });
    // And not on another org's account.
    await expect(worker.execute('ads.sync.record', { adAccountId, details, window: { from: today, to: today }, settleBefore: null, rows: [] }, { actor: SYSTEM, orgId: otherOrgId })).rejects.toMatchObject({ code: 'ADS_ACCOUNT_NOT_FOUND' });
  });

  it('lists the due accounts and prunes old runs for the worker login alone', async () => {
    const due = await adsDue(workerDb, null);
    expect(due.length).toBeGreaterThan(0);
    expect(due.every((d) => d.provider === 'sandbox_ads')).toBe(true);
    // In key order, paged by key.
    const keys = due.map((d) => `${d.orgId}:${d.connectionId}`);
    expect(keys).toEqual([...keys].sort());
    expect(await adsDue(workerDb, { orgId: due.at(-1)?.orgId as string, connectionId: due.at(-1)?.connectionId as string })).toEqual([]);
    // Runs older than 90 days go, newer ones stay.
    const { adAccountId } = accounts.get('Đồng') as { adAccountId: string };
    const entity = (await row<{ legal_entity_id: string }>(`SELECT legal_entity_id FROM crove_ads.ad_account WHERE org_id = $1 AND id = $2`, [orgId, adAccountId]))[0]?.legal_entity_id as string;
    await row(`INSERT INTO crove_ads.ad_sync_run (org_id, ad_account_id, legal_entity_id, status, started_at) VALUES ($1, $2, $3, 'ok', now() - interval '120 days')`, [orgId, adAccountId, entity]);
    const total = async () => Number((await row<{ n: string }>(`SELECT count(*)::text AS n FROM crove_ads.ad_sync_run WHERE org_id = $1`, [orgId]))[0]?.n);
    const before = await total();
    expect(await pruneAdsRuns(workerDb, new Date())).toBeGreaterThanOrEqual(1);
    expect(await total()).toBeLessThan(before);
    // A cutoff in the last day (a wrong clock) clears nothing and is refused.
    await expect(pruneAdsRuns(workerDb, new Date(Date.now() + 100 * 86_400_000))).rejects.toThrow('ADS_PRUNE_CUTOFF');
    expect(await total()).toBeGreaterThan(0);
    const appClient = await pool.connect();
    try {
      await expect(appClient.query(`SELECT crove_ads.sync_runs_prune(now())`)).rejects.toMatchObject({ code: '42501' });
      await expect(appClient.query(`SELECT * FROM crove_ads.ads_due(NULL, NULL, 10)`)).rejects.toMatchObject({ code: '42501' });
    } finally {
      appClient.release();
    }
  });

  // W0a-1 (#2294, ADR-0043): the stops, the state, and the database's guard of the switches and the spend caps. Nothing here
  // calls a platform or spends. What opens the way to spend (the org switch on, an account enabled, a cap set or raised, launches
  // opened again) is a proposal and comes with W0a-2, so the open state a test needs is made the way a proposal's effect will
  // make it: SQL in a signed-in owner's context, committed. The guards fire for every role, the database owner included, so the
  // admin connection of `row()` cannot make it.
  describe('the stops, switches and spend caps of running ads (W0a-1)', () => {
    const callAs = async (who: Account, path: string, input: unknown) => rpc(path, await tokenFor(who), input);
    const key = () => randomUUID();
    const state = async (who: Account = owner) => (await ok('ads/writeState', who, undefined)) as { writeEnabled: boolean; launchesBlocked: boolean; updatedAt: string | null; caps: Array<{ scope: string; adAccountId: string | null; period: string; amount: string; currency: string; setBy: string }>; pending: Array<{ proposalId: string; change: unknown; requestedAt: string }> };
    const settingRows = async () => row<{ n: string }>(`SELECT count(*)::text AS n FROM crove_ads.ad_org_setting WHERE org_id = $1`, [orgId]);
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    // SQL in a context of each kind. Rolled back unless `commit`, since a refused statement aborts the transaction it ran in.
    async function inContext<T>(who: Account | 'system', fn: (c: pg.Client | pg.PoolClient) => Promise<T>, commit = false): Promise<T> {
      const c = await (who === 'system' ? (workerPools[0] as pg.Pool) : pool).connect();
      try {
        await c.query('BEGIN');
        if (who === 'system') await c.query('SELECT crove_kernel.enter_system_context($1::uuid)', [orgId]);
        else {
          const token = mintContextToken(process.env.CROVE_CONTEXT_TOKEN_KEY ?? '', { userId: who.userId, orgId, sessionId: null, aal: 'aal1', mfaAt: null });
          await c.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [orgId, token]);
        }
        await c.query('INSERT INTO crove_ads.ad_org_setting (org_id) VALUES ($1) ON CONFLICT DO NOTHING', [orgId]);
        const out = await fn(c);
        if (commit) await c.query('COMMIT');
        return out;
      } finally {
        await c.query('ROLLBACK').catch(() => undefined);
        c.release();
      }
    }
    const refused = (c: pg.Client | pg.PoolClient, sqlText: string, params: unknown[] = [], message = 'ADS_SWITCH_FORBIDDEN') => expect(c.query(sqlText, params)).rejects.toMatchObject({ code: '42501', message: expect.stringContaining(message) });
    // The org's state as an owner's context leaves it: writing on, launches open, and the given accounts enabled.
    const open = (adAccountIds: string[] = []) =>
      inContext(
        owner,
        async (c) => {
          await c.query('UPDATE crove_ads.ad_org_setting SET write_enabled = true, launches_blocked = false WHERE org_id = $1', [orgId]);
          if (adAccountIds.length > 0) await c.query('UPDATE crove_ads.ad_account SET write_enabled = true WHERE org_id = $1 AND id = ANY ($2::uuid[])', [orgId, adAccountIds]);
        },
        true,
      );
    const closed = () => inContext(owner, (c) => c.query('UPDATE crove_ads.ad_org_setting SET write_enabled = false, launches_blocked = false WHERE org_id = $1', [orgId]), true);

    it('starts off, and only owners and admins read it', async () => {
      expect(await state()).toMatchObject({ writeEnabled: false, launchesBlocked: false, caps: [] });
      expect(await state(adminAccount)).toMatchObject({ writeEnabled: false });
      for (const who of [member, viewer]) expect((await rpc('ads/writeState', await tokenFor(who), undefined)).status, who.email).toBe(403);
      expect((await rpc('ads/writeState', await tokenFor(outsider), undefined)).status).toBe(403);
      // Reading makes no row: the switches exist once someone changes one.
      expect(await settingRows()).toEqual([{ n: '0' }]);
    });

    it('has no direct command that turns writing on, enables an account, sets a cap or opens launches again', async () => {
      for (const path of ['ads/writeEnable', 'ads/enableAccountWrite', 'ads/setCap', 'ads/unblockLaunches']) {
        expect((await rpc(path, await tokenFor(owner, { mfa: true }), { idempotencyKey: key() })).status, path).toBe(404);
      }
    });

    it('switches writing off for the owner alone, with no second factor: every account flag off and launches blocked until an owner opens them', async () => {
      const { adAccountId } = await connect('Tắt cùng tổ chức');
      await open([adAccountId]);
      expect(await state()).toMatchObject({ writeEnabled: true, launchesBlocked: false });
      expect(await view(owner, adAccountId)).toMatchObject({ writeEnabled: true });
      for (const who of [adminAccount, member, viewer]) expect((await callAs(who, 'ads/writeDisable', { idempotencyKey: key() })).status, who.email).toBe(403);
      const off = await callAs(owner, 'ads/writeDisable', { idempotencyKey: key() });
      expect(off).toMatchObject({ status: 200, body: { writeEnabled: false } });
      expect(off.body.accountsDisabled).toBeGreaterThanOrEqual(1);
      expect(await state()).toMatchObject({ writeEnabled: false, launchesBlocked: true });
      expect(await view(owner, adAccountId)).toMatchObject({ writeEnabled: false });
      // The record names the owner and the audit row says what the switch-off closed.
      expect(await row(`SELECT 1 FROM crove_ads.ad_org_setting WHERE org_id = $1 AND updated_by = $2`, [orgId, owner.userId])).toHaveLength(1);
      const audit = await row<{ detail: Record<string, unknown> }>(`SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'ads.write.disable' AND outcome = 'ok' ORDER BY id DESC LIMIT 1`, [orgId]);
      expect(audit[0]?.detail).toMatchObject({ writeEnabled: false, wasEnabled: true });
    });

    it('withdraws one account for the owner alone, with no second factor, and leaves the others and another org’s alone', async () => {
      const { adAccountId } = await connect('Thu hồi một tài khoản');
      const other = await connect('Vẫn bật');
      await open([adAccountId, other.adAccountId]);
      for (const who of [adminAccount, member, viewer]) expect((await callAs(who, 'ads/disableAccountWrite', { adAccountId, idempotencyKey: key() })).status, who.email).toBe(403);
      expect(await callAs(owner, 'ads/disableAccountWrite', { adAccountId, idempotencyKey: key() })).toMatchObject({ status: 200, body: { adAccountId, writeEnabled: false } });
      expect(await view(owner, adAccountId)).toMatchObject({ writeEnabled: false });
      expect(await view(owner, other.adAccountId)).toMatchObject({ writeEnabled: true });
      // Withdrawing again changes nothing and is no error; an account of no org here is not found.
      expect(await callAs(owner, 'ads/disableAccountWrite', { adAccountId, idempotencyKey: key() })).toMatchObject({ status: 200, body: { writeEnabled: false } });
      expect((await callAs(owner, 'ads/disableAccountWrite', { adAccountId: randomUUID(), idempotencyKey: key() })).status).toBe(404);
      expect((await state()).writeEnabled).toBe(true);
    });

    it('stops everything for owners and admins at once, with no second factor, and not for a member or viewer', async () => {
      await open();
      expect(await state()).toMatchObject({ writeEnabled: true, launchesBlocked: false });
      for (const who of [member, viewer]) expect((await callAs(who, 'ads/pauseAll', { idempotencyKey: key() })).status, who.email).toBe(403);
      expect(await callAs(adminAccount, 'ads/pauseAll', { idempotencyKey: key() })).toMatchObject({ status: 200, body: { launchesBlocked: true, paused: 0 } });
      expect(await state()).toMatchObject({ writeEnabled: true, launchesBlocked: true });
      // Stopping twice is no error.
      expect(await callAs(owner, 'ads/pauseAll', { idempotencyKey: key() })).toMatchObject({ status: 200, body: { launchesBlocked: true } });
    });

    // The database keeps the switches to their owners whatever path reaches the table (the Platform PO's conditions on #2294):
    // the commands check the role too, so these go to the table directly, in a context of each kind.
    it('lets only a signed-in owner turn a switch on and only an owner or admin turn it off, in the database whatever the command says', async () => {
      const on = 'UPDATE crove_ads.ad_org_setting SET write_enabled = true WHERE org_id = $1';
      const blockOn = 'UPDATE crove_ads.ad_org_setting SET launches_blocked = true WHERE org_id = $1';
      const blockOff = 'UPDATE crove_ads.ad_org_setting SET launches_blocked = false WHERE org_id = $1';
      const off = 'UPDATE crove_ads.ad_org_setting SET write_enabled = false WHERE org_id = $1';
      // Start from writing off and launches open, so every change below is a change.
      await closed();
      expect(await state()).toMatchObject({ writeEnabled: false, launchesBlocked: false });
      // The owner: both ways.
      await inContext(owner, async (c) => {
        await c.query(on, [orgId]);
        await c.query(blockOn, [orgId]);
        await c.query(blockOff, [orgId]);
        await c.query(off, [orgId]);
      });
      // The admin may stop (block launches, turn off) and may not open (turn on, unblock).
      await inContext(adminAccount, async (c) => {
        await c.query(blockOn, [orgId]);
        await refused(c, blockOff, [orgId]);
      });
      await inContext(adminAccount, (c) => refused(c, on, [orgId]));
      // A member and a viewer may do neither; nor the system (the worker), an agent's context being the same non-user kind.
      for (const who of [member, viewer, 'system'] as const) {
        await inContext(who, (c) => refused(c, on, [orgId]));
        await inContext(who, (c) => refused(c, blockOn, [orgId]));
      }
      // Nothing above was committed: the switches stand as the commands left them.
      expect(await state()).toMatchObject({ writeEnabled: false, launchesBlocked: false });
    });

    it('stamps who changed the switches and when, whatever the writer sent', async () => {
      await closed();
      const before = Date.now();
      await inContext(owner, async (c) => {
        await c.query(`UPDATE crove_ads.ad_org_setting SET write_enabled = true, updated_by = $2, updated_at = '2000-01-01T00:00:00Z' WHERE org_id = $1`, [orgId, member.userId]);
        const stamped = (await c.query<{ updated_by: string; updated_at: Date }>('SELECT updated_by, updated_at FROM crove_ads.ad_org_setting WHERE org_id = $1', [orgId])).rows[0];
        expect(stamped?.updated_by).toBe(owner.userId);
        expect(new Date(stamped?.updated_at ?? 0).getTime()).toBeGreaterThanOrEqual(before - 5_000);
      });
      // A change that touches neither switch is stamped too: whoever sends it is on record, and the system leaves no user.
      await inContext(member, async (c) => {
        await c.query('UPDATE crove_ads.ad_org_setting SET updated_by = $2 WHERE org_id = $1', [orgId, owner.userId]);
        expect((await c.query<{ updated_by: string }>('SELECT updated_by FROM crove_ads.ad_org_setting WHERE org_id = $1', [orgId])).rows[0]?.updated_by).toBe(member.userId);
      });
      await inContext('system', async (c) => {
        await c.query('UPDATE crove_ads.ad_org_setting SET updated_by = $2 WHERE org_id = $1', [orgId, owner.userId]);
        expect((await c.query<{ updated_by: string | null }>('SELECT updated_by FROM crove_ads.ad_org_setting WHERE org_id = $1', [orgId])).rows[0]?.updated_by).toBeNull();
      });
    });

    it('guards an ad account’s flag the same way, on a row changed and on a row born with writing on', async () => {
      const { adAccountId } = await connect('Cổng ở cơ sở dữ liệu');
      const accountOn = 'UPDATE crove_ads.ad_account SET write_enabled = true WHERE org_id = $1 AND id = $2';
      await inContext(owner, async (c) => {
        await c.query(accountOn, [orgId, adAccountId]);
      });
      await inContext(adminAccount, (c) => refused(c, accountOn, [orgId, adAccountId]));
      await inContext(member, (c) => refused(c, accountOn, [orgId, adAccountId]));
      await inContext('system', (c) => refused(c, accountOn, [orgId, adAccountId]));
      // A new row born with the flag on is an opening too (a connection of its own for each, made as the database owner).
      const born = async (flag: boolean) => {
        const connectionId = randomUUID();
        await row(`INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, 'sandbox_ads', $3, 'Sinh ra đã bật', $4)`, [orgId, connectionId, `born-${connectionId}`, owner.userId]);
        return [`INSERT INTO crove_ads.ad_account (org_id, id, channel_connection_id, provider, external_account_id, name, backfill_from, write_enabled) VALUES ($1, $2, $3, 'sandbox_ads', $4, 'Sinh ra đã bật', '2025-10-01', ${flag})`, [orgId, randomUUID(), connectionId, `born-${connectionId}`]] as const;
      };
      const [insertOn, paramsOn] = await born(true);
      await inContext(owner, async (c) => {
        await c.query(insertOn, [...paramsOn]);
      });
      for (const who of [adminAccount, member, viewer, 'system'] as const) await inContext(who, (c) => refused(c, insertOn, [...paramsOn]));
      // A row born with it off is no opening, whoever makes it.
      const [insertOff, paramsOff] = await born(false);
      await inContext(adminAccount, async (c) => {
        await c.query(insertOff, [...paramsOff]);
      });
    });

    it('keeps one row of switches per org in the database: a second row for the org is refused, whoever makes it', async () => {
      for (const who of [owner, adminAccount, member, 'system'] as const) {
        await inContext(who, async (c) => {
          await expect(c.query('INSERT INTO crove_ads.ad_org_setting (org_id) VALUES ($1)', [orgId])).rejects.toMatchObject({ code: '23505', constraint: 'ad_org_setting_org_uq' });
        });
      }
    });

    describe('the spend caps', () => {
      const crafted = 'ffffffff-ffff-7fff-bfff-ffffffffffff';
      const insert = `INSERT INTO crove_ads.ad_spend_cap (org_id, id, scope, period, amount, currency, set_by, set_at) VALUES ($1, $2, 'org', 'daily', $3, 'VND', $4, '2999-01-01T00:00:00Z') RETURNING id, set_by, set_at`;

      it('lets only a signed-in owner insert a cap, and stamps its id, who set it and when, whatever the writer sent', async () => {
        await inContext(owner, async (c) => {
          const made = (await c.query<{ id: string; set_by: string; set_at: Date }>(insert, [orgId, crafted, '1000', member.userId])).rows[0];
          expect(made?.id).not.toBe(crafted);
          expect(made?.set_by).toBe(owner.userId);
          expect(new Date(made?.set_at ?? 0).getTime()).toBeLessThan(Date.now() + 60_000);
        });
        for (const who of [adminAccount, member, viewer, 'system'] as const) await inContext(who, (c) => refused(c, insert, [orgId, crafted, '1000', owner.userId], 'ADS_CAP_FORBIDDEN'));
        // A row of another org is left to row security, which refuses it for the owner of this one.
        await inContext(owner, (c) => refused(c, insert, [otherOrgId, crafted, '1000', owner.userId], 'row-level security'));
      });

      it('shows the latest cap by the order the server stamped, whatever id a writer chose', async () => {
        // The first cap is sent with an id from the far future, the second with one from the past: the later insert is the cap.
        await inContext(owner, (c) => c.query(insert, [orgId, crafted, '5000000', owner.userId]), true);
        await sleep(5);
        await inContext(owner, (c) => c.query(insert, [orgId, '00000000-0000-7000-8000-000000000000', '8000000.50', owner.userId]), true);
        const latest = await state();
        expect(latest.caps.filter((c) => c.scope === 'org' && c.period === 'daily')).toEqual([expect.objectContaining({ amount: '8000000.50', currency: 'VND', setBy: owner.userId })]);
        // The cap history stays: every insert is a row.
        expect((await row<{ n: string }>(`SELECT count(*)::text AS n FROM crove_ads.ad_spend_cap WHERE org_id = $1 AND scope = 'org' AND period = 'daily'`, [orgId]))[0]?.n).toBe('2');
        expect((await rpc('ads/writeState', await tokenFor(member), undefined)).status).toBe(403);
      });

      it('keeps the cap history append-only for every tenant role: no update and no delete of a row', async () => {
        const id = ((await inContext(owner, (c) => c.query<{ id: string }>(insert, [orgId, randomUUID(), '1000', owner.userId]), true)).rows[0] as { id: string }).id;
        for (const who of [owner, adminAccount, member, 'system'] as const) {
          for (const change of ['UPDATE crove_ads.ad_spend_cap SET amount = 1 WHERE org_id = $1 AND id = $2', 'DELETE FROM crove_ads.ad_spend_cap WHERE org_id = $1 AND id = $2']) {
            await inContext(who, async (c) => {
              await expect(c.query(change, [orgId, id])).rejects.toMatchObject({ code: '42501' });
            });
          }
        }
      });
    });

    it('keeps one row of switches per org however the commands interleave, and none for another org', async () => {
      await open();
      await Promise.all([callAs(owner, 'ads/pauseAll', { idempotencyKey: key() }), callAs(adminAccount, 'ads/pauseAll', { idempotencyKey: key() }), callAs(owner, 'ads/writeDisable', { idempotencyKey: key() })]);
      expect(await settingRows()).toEqual([{ n: '1' }]);
      expect(await row(`SELECT 1 FROM crove_ads.ad_org_setting WHERE org_id = $1`, [otherOrgId])).toEqual([]);
      // The other org's owner reads their own, never ours.
      const theirs = (await ok('ads/writeState', outsider, undefined, otherSlug)) as { writeEnabled: boolean; caps: unknown[] };
      expect(theirs).toMatchObject({ writeEnabled: false, caps: [] });
    });

    // W0a-2: what opens the way to spend is a proposal, approved in the Inbox (P10 four-eyes with the one-person path, P11
    // second factor), and the database lets it through for an owner and for that approved proposal's execution alone.
    describe('opening as proposals (W0a-2)', () => {
      const ask = (who: Account, body: Record<string, unknown>, org: string | null = slug) =>
        tokenFor(who).then((token) => rpc('ads/requestChange', token, { idempotencyKey: key(), ...body }, org));
      const approve = async (who: Account, id: string, options: { mfa?: boolean; org?: string | null } = {}) =>
        rpc('inbox/approve', await tokenFor(who, { mfa: options.mfa ?? true }), { id, revision: 1, idempotencyKey: key() }, options.org === undefined ? slug : options.org);
      const proposalId = (made: { status: number; body: { proposalId?: string } }) => {
        expect(made.status, JSON.stringify(made.body)).toBe(200);
        return made.body.proposalId as string;
      };
      const reject = async (who: Account, id: string) => rpc('inbox/reject', await tokenFor(who), { id });
      const orgMonthly = async () => (await state()).caps.filter((c) => c.scope === 'org' && c.period === 'monthly');

      it('asks for writing to be turned on: nothing changes until another eligible person approves it behind a second factor', async () => {
        await closed();
        const id = proposalId(await ask(owner, { change: 'write_enable' }));
        expect(await state()).toMatchObject({ writeEnabled: false, pending: [expect.objectContaining({ proposalId: id, change: { change: 'write_enable' } })] });
        // One question at a time, and the owner alone asks (ADR-0043 points 2, 3 and 7a): an admin approves, never asks.
        expect(await ask(owner, { change: 'write_enable' })).toMatchObject({ status: 409, body: { code: 'ADS_REQUEST_OPEN' } });
        for (const who of [adminAccount, member, viewer]) expect((await ask(who, { change: 'write_enable' })).status, who.email).toBe(403);
        // The author does not approve it when another eligible person exists (P10); the admin needs a second factor (P11).
        expect(await approve(owner, id)).toMatchObject({ status: 403, body: { code: 'FOUR_EYES_REQUIRED' } });
        expect(await approve(adminAccount, id, { mfa: false })).toMatchObject({ status: 403, body: { code: 'STEP_UP_REQUIRED' } });
        expect((await state()).writeEnabled).toBe(false);
        expect((await approve(adminAccount, id)).status).toBe(200);
        expect(await state()).toMatchObject({ writeEnabled: true, pending: [] });
        // The switch records the approver, and a repeat is refused before it is a proposal.
        expect(await row(`SELECT 1 FROM crove_ads.ad_org_setting WHERE org_id = $1 AND updated_by = $2`, [orgId, adminAccount.userId])).toHaveLength(1);
        expect(await ask(owner, { change: 'write_enable' })).toMatchObject({ status: 409, body: { code: 'ADS_WRITE_ALREADY_ON' } });
      });

      it('enables an account only while the org switch is on, by approval, and says so before it is asked', async () => {
        await open();
        const { adAccountId } = await connect('Mở bằng đề xuất');
        const other = await connect('Chưa xin mở');
        const id = proposalId(await ask(owner, { change: 'account_enable', adAccountId }));
        expect(await ask(owner, { change: 'account_enable', adAccountId })).toMatchObject({ status: 409, body: { code: 'ADS_REQUEST_OPEN' } });
        expect((await view(owner, adAccountId))?.writeEnabled).toBe(false);
        expect((await approve(adminAccount, id)).status).toBe(200);
        expect(await view(owner, adAccountId)).toMatchObject({ writeEnabled: true });
        expect(await view(owner, other.adAccountId)).toMatchObject({ writeEnabled: false });
        expect(await ask(owner, { change: 'account_enable', adAccountId })).toMatchObject({ status: 409, body: { code: 'ADS_ACCOUNT_ALREADY_ON' } });
        expect((await ask(owner, { change: 'account_enable', adAccountId: randomUUID() })).status).toBe(404);
        // With the org switch off it is refused at the request.
        await callAs(owner, 'ads/writeDisable', { idempotencyKey: key() });
        expect(await ask(owner, { change: 'account_enable', adAccountId: other.adAccountId })).toMatchObject({ status: 409, body: { code: 'ADS_WRITE_OFF' } });
      });

      it('sets and raises a cap by approval, lowers it directly for the owner, and checks the account’s currency', async () => {
        await open();
        const orgCap = { change: 'cap_set', scope: 'org', period: 'monthly', amount: '5000000', currency: 'VND' };
        expect((await approve(adminAccount, proposalId(await ask(owner, orgCap)))).status).toBe(200);
        // Who set it is the approver, the one whose approval it is.
        expect(await orgMonthly()).toEqual([expect.objectContaining({ amount: '5000000', currency: 'VND', setBy: adminAccount.userId })]);
        // A raise is a proposal; a cap that is not above the one in force is refused, with the way to lower it.
        expect(await ask(owner, { ...orgCap, amount: '5000000.00' })).toMatchObject({ status: 422, body: { code: 'ADS_CAP_NOT_RAISED' } });
        expect(await ask(owner, { ...orgCap, amount: '4000000' })).toMatchObject({ status: 422, body: { code: 'ADS_CAP_NOT_RAISED' } });
        expect((await approve(adminAccount, proposalId(await ask(owner, { ...orgCap, amount: '8000000.50' })))).status).toBe(200);
        expect(await orgMonthly()).toEqual([expect.objectContaining({ amount: '8000000.50' })]);
        // Lowering needs no proposal and no second factor, is the owner's, and goes strictly below the cap in force.
        const lower = (who: Account, body: Record<string, unknown>) => callAs(who, 'ads/lowerCap', { idempotencyKey: key(), ...body });
        const lowerOrg = { scope: 'org', period: 'monthly', amount: '7000000' };
        expect((await lower(adminAccount, lowerOrg)).status).toBe(403);
        expect(await lower(owner, lowerOrg)).toMatchObject({ status: 200, body: { previous: '8000000.50' } });
        expect(await lower(owner, lowerOrg)).toMatchObject({ status: 422, body: { code: 'ADS_CAP_NOT_LOWER' } });
        expect(await lower(owner, { ...lowerOrg, scope: 'account', adAccountId: randomUUID() })).toMatchObject({ status: 404 });
        expect(await orgMonthly()).toEqual([expect.objectContaining({ amount: '7000000', currency: 'VND' })]);
        // An account cap is in the account's own currency, and only once the account has updated.
        const usd = await connect('Hạn mức USD', { currency: 'USD' });
        // The account's currency is the platform's, known after its first sync.
        await sync(usd.connectionId);
        const accountCap = { change: 'cap_set', scope: 'account', adAccountId: usd.adAccountId, period: 'daily', amount: '200', currency: 'VND' };
        expect(await ask(owner, accountCap)).toMatchObject({ status: 422, body: { code: 'ADS_CAP_CURRENCY' } });
        expect((await approve(adminAccount, proposalId(await ask(owner, { ...accountCap, currency: 'USD' })))).status).toBe(200);
        expect((await state()).caps).toContainEqual(expect.objectContaining({ scope: 'account', adAccountId: usd.adAccountId, currency: 'USD', amount: '200' }));
        expect(await lower(owner, { scope: 'account', adAccountId: usd.adAccountId, period: 'monthly', amount: '100' })).toMatchObject({ status: 409, body: { code: 'ADS_CAP_NOT_SET' } });
        const fresh = await connect('Chưa cập nhật');
        await row(`UPDATE crove_ads.ad_account SET currency = NULL WHERE org_id = $1 AND id = $2`, [orgId, fresh.adAccountId]);
        expect(await ask(owner, { ...accountCap, adAccountId: fresh.adAccountId })).toMatchObject({ status: 422, body: { code: 'ADS_CAP_ACCOUNT_UNSYNCED' } });
        // The shapes the request refuses: an org cap naming an account, an account cap naming none, zero, a third decimal, a typo.
        for (const bad of [{ ...orgCap, adAccountId: usd.adAccountId }, { change: 'cap_set', scope: 'account', period: 'daily', amount: '1', currency: 'VND' }, { ...orgCap, amount: '0' }, { ...orgCap, amount: '1.234' }, { ...orgCap, currency: 'VDN' }]) {
          expect((await ask(owner, bad)).status, JSON.stringify(bad)).toBe(400);
        }
      });

      it('opens launches again by approval, and only while they are blocked', async () => {
        await open();
        expect(await ask(owner, { change: 'launches_unblock' })).toMatchObject({ status: 409, body: { code: 'ADS_LAUNCHES_NOT_BLOCKED' } });
        await callAs(adminAccount, 'ads/pauseAll', { idempotencyKey: key() });
        expect((await state()).launchesBlocked).toBe(true);
        const id = proposalId(await ask(owner, { change: 'launches_unblock' }));
        expect((await approve(adminAccount, id)).status).toBe(200);
        expect((await state()).launchesBlocked).toBe(false);
      });

      it('lets a one-person org approve its own request, flagged, and shows the request to nobody of another org', async () => {
        const id = proposalId(await ask(outsider, { change: 'write_enable' }, otherSlug));
        // The first org sees none of it.
        expect((await state()).pending.map((p) => p.proposalId)).not.toContain(id);
        expect((await approve(outsider, id, { org: otherSlug })).status).toBe(200);
        expect(await ok('ads/writeState', outsider, undefined, otherSlug)).toMatchObject({ writeEnabled: true });
        const audit = await row<{ detail: Record<string, unknown> }>(`SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'kernel.proposal.approve' AND outcome = 'ok' ORDER BY id DESC LIMIT 1`, [otherOrgId]);
        expect(audit[0]?.detail).toMatchObject({ self_approved: true, policy: { P10: 'self_approved' } });
        // Another org's request cannot be approved from here.
        expect((await approve(owner, id)).status).toBe(404);
      });

      it('rejects a request without changing anything, and a rejected one can be asked for again', async () => {
        await closed();
        const id = proposalId(await ask(owner, { change: 'write_enable' }));
        expect((await reject(adminAccount, id)).status).toBe(200);
        expect(await state()).toMatchObject({ writeEnabled: false, pending: [] });
        const again = proposalId(await ask(owner, { change: 'write_enable' }));
        expect((await reject(adminAccount, again)).status).toBe(200);
      });

      it('refuses an approval of a request made against a cap that has since been lowered, and of an unblock made before a stop', async () => {
        await open();
        // A cap on a fresh account, in its currency: set by approval, then a raise is asked for, then the owner lowers the cap
        // (an incident), and the old raise is refused when it is approved: the stop is not undone.
        const account = await connect('Hạn mức cũ');
        await sync(account.connectionId);
        const base = { change: 'cap_set', scope: 'account', adAccountId: account.adAccountId, period: 'daily', currency: 'VND' };
        expect((await approve(adminAccount, proposalId(await ask(owner, { ...base, amount: '100' })))).status).toBe(200);
        const raise = proposalId(await ask(owner, { ...base, amount: '500' }));
        expect((await callAs(owner, 'ads/lowerCap', { idempotencyKey: key(), scope: 'account', adAccountId: account.adAccountId, period: 'daily', amount: '50' })).status).toBe(200);
        expect(await approve(adminAccount, raise)).toMatchObject({ status: 409, body: { code: 'ADS_CAP_CHANGED' } });
        const current = (await state()).caps.find((c) => c.adAccountId === account.adAccountId && c.period === 'daily');
        expect(current).toMatchObject({ amount: '50' });
        expect((await reject(adminAccount, raise)).status).toBe(200);
        // An unblock asked for while launches were blocked, then the owner switches writing off (which blocks again): the old
        // request is refused, and launches stay blocked.
        await callAs(adminAccount, 'ads/pauseAll', { idempotencyKey: key() });
        const unblock = proposalId(await ask(owner, { change: 'launches_unblock' }));
        expect((await callAs(owner, 'ads/writeDisable', { idempotencyKey: key() })).status).toBe(200);
        expect(await approve(adminAccount, unblock)).toMatchObject({ status: 409, body: { code: 'ADS_BLOCK_CHANGED' } });
        expect((await state()).launchesBlocked).toBe(true);
        expect((await reject(adminAccount, unblock)).status).toBe(200);
      });

      it('lowers a cap even when the database clock is behind the newest cap id, and the lowered cap is the latest', async () => {
        await open();
        const account = await connect('Đồng hồ lùi');
        await sync(account.connectionId);
        // A cap whose id is far ahead of the clock (as after a clock that stepped back), put in by the database owner outside
        // any session, where the guard does not stamp it.
        await row(
          `INSERT INTO crove_ads.ad_spend_cap (org_id, id, scope, ad_account_id, period, amount, currency, set_by) VALUES ($1, '03bb2cc3-d800-7000-8000-000000000000', 'account', $2, 'daily', '100', 'VND', $3)`,
          [orgId, account.adAccountId, owner.userId],
        );
        const lowered = await callAs(owner, 'ads/lowerCap', { idempotencyKey: key(), scope: 'account', adAccountId: account.adAccountId, period: 'daily', amount: '50' });
        expect(lowered).toMatchObject({ status: 200, body: { previous: '100' } });
        const current = (await state()).caps.find((c) => c.adAccountId === account.adAccountId && c.period === 'daily');
        expect(current).toMatchObject({ amount: '50' });
        // And the next one still follows it.
        expect(await callAs(owner, 'ads/lowerCap', { idempotencyKey: key(), scope: 'account', adAccountId: account.adAccountId, period: 'daily', amount: '40' })).toMatchObject({ status: 200, body: { previous: '50' } });
      });

      it('never approves them in a batch, whatever the screen offers: each is refused item by item and nothing changes', async () => {
        await closed();
        const id = proposalId(await ask(owner, { change: 'write_enable' }));
        const batch = await rpc('inbox/approveMany', await tokenFor(adminAccount, { mfa: true }), { items: [{ id, revision: 1 }], idempotencyKey: key() });
        expect(batch).toMatchObject({ status: 200, body: { results: [{ id, outcome: 'refused', code: 'BULK_NOT_ALLOWED' }] } });
        expect((await state()).writeEnabled).toBe(false);
        expect((await reject(adminAccount, id)).status).toBe(200);
      });

      it('keeps the one-person rule at approval time: an owner who asked alone cannot approve once an admin has joined, and the admin can', async () => {
        // The one-person org of the owner `outsider`: a request made while the owner is the only eligible person.
        const id = proposalId(await ask(outsider, { change: 'cap_set', scope: 'org', period: 'daily', amount: '1000', currency: 'VND' }, otherSlug));
        // An admin joins the org afterwards (the staff connection: the invite flow is the kernel's, tested elsewhere).
        await row(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin')`, [otherOrgId, adminAccount.userId]);
        try {
          // The owner may no longer approve their own request, though the snapshot taken at the request names only them ...
          expect(await approve(outsider, id, { org: otherSlug })).toMatchObject({ status: 403, body: { code: 'FOUR_EYES_REQUIRED' } });
          // ... and the admin, who is not in that snapshot, may.
          expect((await approve(adminAccount, id, { org: otherSlug })).status).toBe(200);
          expect(await ok('ads/writeState', outsider, undefined, otherSlug)).toMatchObject({ caps: [expect.objectContaining({ amount: '1000', setBy: adminAccount.userId })] });
        } finally {
          await row(`DELETE FROM crove_kernel.tenant_member WHERE org_id = $1 AND user_id = $2`, [otherOrgId, adminAccount.userId]);
        }
      });

      it('decides an ads approval in TypeScript and in the database alike, on the members of the org now', async () => {
        const user = (who: Account) => ({ type: 'user', id: who.userId });
        const snapshots = [[], [owner.userId], [owner.userId, adminAccount.userId]];
        const authorSets = [[user(owner)], [user(adminAccount)], [user(owner), user(adminAccount)]];
        let checked = 0;
        for (const command of ['ads.write.enable', 'ads.cap.set']) {
          for (const snapshot of snapshots) {
            for (const authors of authorSets) {
              for (const who of [owner, adminAccount, member, viewer]) {
                const ts = await appDb.transaction().execute(async (trx) => {
                  const token = mintContextToken(process.env.CROVE_CONTEXT_TOKEN_KEY ?? '', { userId: who.userId, orgId, sessionId: null, aal: 'aal1', mfaAt: null });
                  await sql`SELECT crove_kernel.enter_user_context(${orgId}::uuid, ${token}::text)`.execute(trx);
                  return decideApproval(trx, orgId, { type: 'user', userId: who.userId, aal: 'aal1', sessionId: randomUUID() }, { command, status: 'pending', eligible_approvers: snapshot, authors }, { lock: false });
                });
                const inDb = (
                  await row<{ d: { reason: string; eligibleCount: number; selfApproved: boolean; fourEyes: string } }>(
                    `SELECT crove_kernel.proposal_approval_decide($1::uuid, $2, 'pending', $3::uuid[], $4::jsonb, $5::uuid, false) AS d`,
                    [orgId, command, snapshot, JSON.stringify(authors), who.userId],
                  )
                )[0]?.d;
                const where = JSON.stringify({ command, snapshot, authors, actor: who.email });
                expect({ reason: inDb?.reason, eligibleCount: inDb?.eligibleCount, selfApproved: inDb?.selfApproved, fourEyes: inDb?.fourEyes }, where).toEqual({
                  reason: ts.reason,
                  eligibleCount: ts.eligibleCount,
                  selfApproved: ts.selfApproved,
                  fourEyes: ts.fourEyes,
                });
                checked += 1;
              }
            }
          }
        }
        expect(checked).toBe(72);
        // The reading is the org's members now, whatever the snapshot holds: with an owner and an admin, an owner who wrote it
        // alone is refused and the admin is not, with none or either of them in the snapshot.
        const decide = async (who: Account, snapshot: string[], authors: unknown[]) =>
          (await row<{ d: { reason: string } }>(`SELECT crove_kernel.proposal_approval_decide($1::uuid, 'ads.cap.set', 'pending', $2::uuid[], $3::jsonb, $4::uuid, false) AS d`, [orgId, snapshot, JSON.stringify(authors), who.userId]))[0]?.d.reason;
        expect(await decide(owner, [owner.userId], [user(owner)])).toBe('four_eyes');
        expect(await decide(adminAccount, [owner.userId], [user(owner)])).toBe('ok');
        expect(await decide(adminAccount, [], [user(owner)])).toBe('ok');
      });

      // The database half, in SQL, in a context of each kind (rolled back): the change goes through for the execution of an
      // approved proposal of its own command that names this very change, in the transaction that approved it, and for
      // nothing else.
      it('lets the database pass a change only inside the execution of its own approved proposal, naming that change', async () => {
        // Writing off and launches blocked, so there are two different openings to try.
        await inContext(owner, (c) => c.query('UPDATE crove_ads.ad_org_setting SET write_enabled = false, launches_blocked = true WHERE org_id = $1', [orgId]), true);
        const enable = proposalId(await ask(owner, { change: 'write_enable' }));
        const on = 'UPDATE crove_ads.ad_org_setting SET write_enabled = true WHERE org_id = $1';
        const approveRaw = (c: pg.Client | pg.PoolClient, id: string) => c.query('SELECT crove_kernel.proposal_approve($1::uuid, 1, $2::uuid)', [id, randomUUID()]);
        // Pending is not approved: the admin's own statement is refused.
        await inContext(adminAccount, (c) => refused(c, on, [orgId]));
        // Approved in this transaction by this user, for this command: it passes; another opening still does not.
        await inContext(adminAccount, async (c) => {
          await approveRaw(c, enable);
          await c.query(on, [orgId]);
          await refused(c, 'UPDATE crove_ads.ad_org_setting SET launches_blocked = false WHERE org_id = $1', [orgId]);
        });
        // Approving a proposal does not make any other change: another account, then another cap, are still refused.
        await open();
        const { adAccountId } = await connect('Cổng đề xuất');
        const other = await connect('Tài khoản khác');
        const account = proposalId(await ask(owner, { change: 'account_enable', adAccountId }));
        const flag = 'UPDATE crove_ads.ad_account SET write_enabled = true WHERE org_id = $1 AND id = $2';
        await inContext(adminAccount, async (c) => {
          await approveRaw(c, account);
          await c.query(flag, [orgId, adAccountId]);
          await refused(c, flag, [orgId, other.adAccountId]);
        });
        const capProposal = proposalId(await ask(owner, { change: 'cap_set', scope: 'org', period: 'daily', amount: '90000000', currency: 'VND' }));
        const capSql = `INSERT INTO crove_ads.ad_spend_cap (org_id, scope, period, amount, currency, set_by) VALUES ($1, 'org', $2, $3, 'VND', $4)`;
        const capParams = (amount: string, period: string) => [orgId, period, amount, adminAccount.userId];
        // Each attempt in a transaction of its own: a refused statement aborts the one it ran in.
        const approvedCap = (attempt: (c: pg.Client | pg.PoolClient) => Promise<unknown>) =>
          inContext(adminAccount, async (c) => {
            await approveRaw(c, capProposal);
            await attempt(c);
          });
        await approvedCap((c) => refused(c, capSql, capParams('95000000', 'daily'), 'ADS_CAP_FORBIDDEN'));
        await approvedCap((c) => refused(c, capSql, capParams('90000000', 'monthly'), 'ADS_CAP_FORBIDDEN'));
        // Another opening, an account's flag, is not the cap that was approved.
        await approvedCap((c) => refused(c, flag, [orgId, other.adAccountId]));
        await approvedCap((c) => c.query(capSql, capParams('90000000', 'daily')));
        // Rewriting the approved proposal's payload in the same transaction does not make another change pass: the guard
        // reads the revision that was approved, and the rewrite is refused or the new amount is.
        await approvedCap(async (c) => {
          await c.query('SAVEPOINT rewrite');
          await c.query(
            `UPDATE crove_kernel.proposal SET payload = jsonb_set(payload, '{amount}', '"123"'), revision = 2, authors = authors || jsonb_build_array(jsonb_build_object('type', 'user', 'id', $2::text)) WHERE org_id = $1 AND id = $3`,
            [orgId, adminAccount.userId, capProposal],
          ).catch(() => c.query('ROLLBACK TO SAVEPOINT rewrite'));
          await refused(c, capSql, capParams('123', 'daily'), 'ADS_CAP_FORBIDDEN');
        });
        // The system's kind of context never passes, even with a row in the state `approved`: only a user decides. (Writing is
        // off again first, so turning it on is a change.)
        await inContext(owner, (c) => c.query('UPDATE crove_ads.ad_org_setting SET write_enabled = false WHERE org_id = $1', [orgId]), true);
        await inContext('system', async (c) => {
          await c.query(`UPDATE crove_kernel.proposal SET status = 'approved', executed_command_id = $2::uuid, decided_at = now() WHERE org_id = $1 AND id = $3`, [orgId, randomUUID(), enable]);
          await refused(c, on, [orgId]);
        });
        // No login role can call the marker, and the ids of caps made one after another only grow.
        for (const who of [owner, adminAccount, 'system'] as const) {
          await inContext(who, async (c) => {
            await expect(c.query(`SELECT crove_ads.approved_execution('ads.cap.set')`)).rejects.toMatchObject({ code: '42501' });
          });
        }
        await inContext(owner, async (c) => {
          const ids: string[] = [];
          for (let n = 1; n <= 15; n += 1) {
            ids.push(((await c.query<{ id: string }>(`INSERT INTO crove_ads.ad_spend_cap (org_id, scope, period, amount, currency, set_by) VALUES ($1, 'org', 'daily', $2, 'VND', $3) RETURNING id`, [orgId, String(n), owner.userId])).rows[0] as { id: string }).id);
          }
          expect(ids, 'the id of a cap made after another is above it, even within one millisecond').toEqual([...ids].sort());
          expect(new Set(ids).size).toBe(ids.length);
          // An amount that is not a finite number is no cap.
          await expect(c.query(`INSERT INTO crove_ads.ad_spend_cap (org_id, scope, period, amount, currency, set_by) VALUES ($1, 'org', 'daily', 'NaN', 'VND', $2)`, [orgId, owner.userId])).rejects.toMatchObject({ code: '23514' });
        });
        // Clear what is left open in the org.
        for (const id of [enable, account, capProposal]) await reject(adminAccount, id);
      });

      // W1 (#2295): the campaign draft. Built and checked here, submitted by an owner or an admin as a proposal of ads.campaign.launch that names the plan, its
      // hash and the largest amount it can spend; approved in the Inbox like any money; in W1 an approved plan is only marked approved, nothing leaves Ludy.
      describe('campaign drafts (W1, #2295)', () => {
        const zone = 'Asia/Ho_Chi_Minh';
        const inDays = (n: number) => addDays(todayIn(zone, new Date()), n);
        const plan = (over: Record<string, unknown> = {}) => ({
          name: 'Khuyến mãi cuối tuần',
          objective: 'traffic',
          dailyBudget: '100000',
          startOn: inDays(2),
          endOn: inDays(8),
          targeting: { locations: [{ country: 'VN' }], ageMin: 22, ageMax: 45, gender: 'all', interests: ['Cà phê'] },
          linkUrl: 'https://example.com/khuyen-mai',
          variants: [{ headline: 'Giảm 20% cuối tuần', primaryText: 'Ghé quán hôm nay để nhận ưu đãi.', callToAction: 'learn_more' }],
          ...over,
        });
        const save = (who: Account, adAccountId: string, body: Record<string, unknown>, draftId?: string) => callAs(who, 'ads/saveCampaignDraft', { idempotencyKey: key(), adAccountId, plan: body, ...(draftId ? { draftId } : {}) });
        const saved = async (who: Account, adAccountId: string, body: Record<string, unknown>, draftId?: string) => {
          const made = await save(who, adAccountId, body, draftId);
          expect(made.status, JSON.stringify(made.body)).toBe(200);
          return made.body as { id: string; revision: number; status: string; maxSpend: string | null; days: number | null; issues: Array<{ code: string; severity: string; field: string | null }>; pendingProposalId: string | null; currency: string | null; aiFields: string[] };
        };
        const codes = (d: { issues: Array<{ code: string; severity: string }> }) => d.issues.map((i) => `${i.severity}:${i.code}`);
        const submit = (who: Account, draftId: string) => ask(who, { change: 'campaign_launch', draftId });
        // The org's switch on, an account that has read its currency, enabled for running ads, with an org daily cap of 200 000 and a monthly one of 5 000 000.
        const ready = async (name: string) => {
          // An approved plan holds its amount against the caps as a queued launch (W2-2): the ones the tests before left are released, so each test starts from
          // the caps alone (the ledger's own tests are in invariant/ads-launch-ledger.db.test.ts and below).
          for (const l of await row<{ id: string }>(`SELECT id FROM crove_ads.ad_launch WHERE org_id = $1 AND state = 'queued'`, [orgId])) {
            expect((await callAs(owner, 'ads/cancelLaunch', { launchId: l.id, idempotencyKey: key() })).status).toBe(200);
          }
          // The launches the job tests (W2-3) leave started hold their commitment too: the system, which knows nothing ran, releases them.
          await inContext('system', (c) => c.query(`UPDATE crove_ads.ad_launch SET state = 'stopped', commit_until = NULL, stop_reason = 'test_cleanup' WHERE org_id = $1 AND state IN ('launching', 'needs_attention')`, [orgId]), true);
          await open();
          const made = await connect(name);
          await sync(made.connectionId);
          const ids = [proposalId(await ask(owner, { change: 'account_enable', adAccountId: made.adAccountId }))];
          // The org's caps are exactly these, whatever the tests before left: a raise is a proposal, a lowering the owner's direct stop.
          for (const period of ['daily', 'monthly'] as const) {
            const amount = period === 'daily' ? '200000' : '5000000';
            const current = (await state()).caps.find((c) => c.scope === 'org' && c.period === period);
            if (!current || Number(current.amount) < Number(amount)) ids.push(proposalId(await ask(owner, { change: 'cap_set', scope: 'org', period, amount, currency: 'VND' })));
            else if (Number(current.amount) > Number(amount)) expect((await callAs(owner, 'ads/lowerCap', { idempotencyKey: key(), scope: 'org', period, amount })).status).toBe(200);
          }
          for (const id of ids) expect((await approve(adminAccount, id)).status).toBe(200);
          return made.adAccountId;
        };
        const draftRow = async (id: string) => (await row<{ status: string; revision: number; proposal_id: string | null; approved_at: Date | null; max_spend: string | null; daily_budget: string | null }>(`SELECT status, revision, proposal_id, approved_at, max_spend::text AS max_spend, daily_budget::text AS daily_budget FROM crove_ads.ad_campaign_draft WHERE org_id = $1 AND id = $2`, [orgId, id]))[0];
        const refusedBy = (sqlText: string, params: unknown[], message: string) => expect(row(sqlText, params), message).rejects.toMatchObject({ message: expect.stringContaining(message) });

        it('lets an owner, an admin and a member draft, a viewer none; a plan in progress needs only a name and an objective, and says what is missing', async () => {
          const account = await ready('Bản nháp');
          const draft = await saved(member, account, { name: 'Mới', objective: 'traffic' });
          expect(draft).toMatchObject({ status: 'draft', revision: 1, maxSpend: null, days: null, currency: 'VND', aiFields: [], pendingProposalId: null });
          expect(codes(draft)).toEqual(expect.arrayContaining(['error:missing_field']));
          expect(draft.issues.filter((i) => i.code === 'missing_field').map((i) => i.field)).toEqual(['dailyBudget', 'startOn', 'endOn', 'targeting', 'variants', 'linkUrl']);
          expect((await save(viewer, account, plan())).status).toBe(403);
          for (const who of [owner, adminAccount, member]) expect((await save(who, account, plan())).status, who.email).toBe(200);
          expect((await callAs(viewer, 'ads/campaignDrafts', {})).status).toBe(403);
          // A plan that is complete and inside the caps has nothing to say and a largest amount: 100 000 a day for 7 days.
          const full = await saved(member, account, plan());
          expect(full).toMatchObject({ maxSpend: '700000', days: 7, issues: [] });
          // An edit raises the revision, keeps what it does not name, and recomputes the amount.
          const edited = await saved(adminAccount, account, plan({ dailyBudget: '150000' }), draft.id);
          expect(edited).toMatchObject({ id: draft.id, revision: 2, maxSpend: '1050000', days: 7, issues: [] });
          expect(await draftRow(draft.id)).toMatchObject({ revision: 2, max_spend: '1050000', daily_budget: '150000' });
          // An editor that sends the revision it read does not overwrite a later save: the stale one is refused, the current one goes through.
          const stale = (revision: number) => callAs(owner, 'ads/saveCampaignDraft', { idempotencyKey: key(), adAccountId: account, draftId: draft.id, plan: { name: 'Sửa từ bản cũ', objective: 'traffic' }, expectedRevision: revision });
          expect(await stale(1)).toMatchObject({ status: 409, body: { code: 'ADS_DRAFT_STALE' } });
          expect((await draftRow(draft.id))?.revision).toBe(2);
          expect((await stale(2)).status).toBe(200);
          // The list and the single read agree, and a draft discarded leaves the list.
          const listed = (await callAs(owner, 'ads/campaignDrafts', { adAccountId: account })).body as Array<{ id: string }>;
          expect(listed.map((d) => d.id)).toContain(draft.id);
          expect((await callAs(owner, 'ads/campaignDraft', { draftId: draft.id })).body).toMatchObject({ id: draft.id, revision: 3 });
          expect((await callAs(member, 'ads/discardCampaignDraft', { draftId: full.id, idempotencyKey: key() })).status).toBe(200);
          expect(((await callAs(owner, 'ads/campaignDrafts', { adAccountId: account })).body as Array<{ id: string }>).map((d) => d.id)).not.toContain(full.id);
          expect((await save(owner, account, plan(), full.id)).status).toBe(409);
        });

        it('judges a plan against the dates, the budget and the caps in force, to the cent, and keeps the account’s currency', async () => {
          const account = await ready('Kiểm tra cục bộ');
          expect(codes(await saved(owner, account, plan({ startOn: inDays(-1) })))).toContain('error:start_in_past');
          expect(codes(await saved(owner, account, plan({ endOn: inDays(1) })))).toContain('error:end_before_start');
          expect(codes(await saved(owner, account, plan({ dailyBudget: '200001' })))).toContain('error:daily_cap_exceeded');
          expect(codes(await saved(owner, account, plan({ dailyBudget: '200000' })))).toEqual([]);
          expect(codes(await saved(owner, account, plan({ dailyBudget: '200000', startOn: inDays(1), endOn: inDays(60) })))).toContain('error:monthly_cap_exceeded');
          // Whole dong only; a third decimal is not a budget at all.
          expect(codes(await saved(owner, account, plan({ dailyBudget: '100000.5' })))).toContain('error:budget_decimals');
          expect((await save(owner, account, plan({ dailyBudget: '1.234' }))).status).toBe(400);
          // The shapes the contract refuses: more than three variants, a link that is not https, an interest list past its limit.
          const variants = Array.from({ length: 4 }, () => ({ headline: 'Tiêu đề', primaryText: 'Nội dung', callToAction: 'learn_more' }));
          for (const bad of [{ variants }, { linkUrl: 'http://example.com' }, { targeting: { locations: [{ country: 'VN' }], ageMin: 22, ageMax: 45, gender: 'all', interests: Array.from({ length: 21 }, (_, i) => `sở thích ${i}`) } }, { objective: 'sales' }]) {
            expect((await save(owner, account, plan(bad))).status, JSON.stringify(bad).slice(0, 60)).toBe(400);
          }
          // Messenger wants a Page that is a connection of the org.
          const messenger = await saved(owner, account, plan({ objective: 'messenger', linkUrl: null }));
          expect(messenger.issues.filter((i) => i.code === 'missing_field').map((i) => i.field)).toEqual(['pageConnectionId']);
          // A connection of the org that is not a Facebook Page (the account's own, for reading) is not a Page; an id that is not the org's is refused.
          const readConnection = (await row<{ id: string }>(`SELECT channel_connection_id AS id FROM crove_ads.ad_account WHERE org_id = $1 AND id = $2`, [orgId, account]))[0]?.id as string;
          expect(codes(await saved(owner, account, plan({ objective: 'messenger', linkUrl: null, pageConnectionId: readConnection }), messenger.id))).toContain('error:page_not_found');
          expect(await save(owner, account, plan({ objective: 'messenger', linkUrl: null, pageConnectionId: randomUUID() }), messenger.id)).toMatchObject({ status: 422, body: { code: 'ADS_DRAFT_REFERENCE' } });
          expect(await save(owner, account, plan({ mediaFileId: randomUUID() }))).toMatchObject({ status: 422, body: { code: 'ADS_DRAFT_REFERENCE' } });
          // The caps are the owners' and admins' to read: a member is told a cap is exceeded, not its amount.
          const overAsMember = await saved(member, account, plan({ dailyBudget: '300000' }));
          expect(overAsMember.issues.find((i) => i.code === 'daily_cap_exceeded')).toEqual({ code: 'daily_cap_exceeded', severity: 'error', field: 'dailyBudget', params: { scope: 'org', budget: '300000' } });
          const overAsOwner = await saved(owner, account, plan({ dailyBudget: '300000' }));
          expect(overAsOwner.issues.find((i) => i.code === 'daily_cap_exceeded')).toMatchObject({ params: { scope: 'org', cap: '200000', budget: '300000' } });
        });

        it('submits a plan for approval only when it is complete and judged clean, one request at a time, by an owner or an admin', async () => {
          const account = await ready('Gửi duyệt');
          const incomplete = await saved(owner, account, { name: 'Dở dang', objective: 'traffic' });
          expect(await submit(owner, incomplete.id)).toMatchObject({ status: 422, body: { code: 'ADS_DRAFT_INCOMPLETE' } });
          const over = await saved(owner, account, plan({ dailyBudget: '300000' }));
          expect(await submit(owner, over.id)).toMatchObject({ status: 422, body: { code: 'ADS_DRAFT_INVALID' } });
          const good = await saved(member, account, plan());
          // A member drafts; asking for approval is the owner's or an admin's, and a viewer's nothing.
          expect((await submit(member, good.id)).status).toBe(403);
          expect((await submit(viewer, good.id)).status).toBe(403);
          expect((await submit(owner, randomUUID())).status).toBe(404);
          // Nothing but a signed-in owner or admin asks: not the system, and so not an agent either (no agent is listed for the command).
          await expect(api.execute('ads.campaign.prepare_launch', { draftId: good.id }, { actor: SYSTEM, orgId })).rejects.toBeTruthy();
          await expect(api.execute('ads.campaign.draft_save', { adAccountId: account, plan: plan() }, { actor: SYSTEM, orgId })).rejects.toBeTruthy();
          const id = proposalId(await submit(adminAccount, good.id));
          expect(await submit(owner, good.id)).toMatchObject({ status: 409, body: { code: 'ADS_REQUEST_OPEN' } });
          // The card: the plan whole and the largest amount; the proposal's own amount is the one the approver signs.
          expect((await callAs(owner, 'ads/proposal', { id })).body).toMatchObject({ change: { change: 'campaign_launch', draftId: good.id, amount: '700000', currency: 'VND', days: 7, plan: { name: 'Khuyến mãi cuối tuần', dailyBudget: '100000' } } });
          expect((await row<{ amount: string; kind: string }>(`SELECT payload ->> 'amount' AS amount, kind FROM crove_kernel.proposal WHERE org_id = $1 AND id = $2`, [orgId, id]))[0]).toEqual({ amount: '700000', kind: 'ads.campaign_launch' });
          // While the request waits the draft is frozen: for the commands (a friendly refusal) and for the database, whatever path reaches it.
          expect(await save(owner, account, plan({ dailyBudget: '90000' }), good.id)).toMatchObject({ status: 409, body: { code: 'ADS_DRAFT_SUBMITTED' } });
          expect(await callAs(owner, 'ads/discardCampaignDraft', { draftId: good.id, idempotencyKey: key() })).toMatchObject({ status: 409, body: { code: 'ADS_DRAFT_SUBMITTED' } });
          await refusedBy(`UPDATE crove_ads.ad_campaign_draft SET daily_budget = 1 WHERE org_id = $1 AND id = $2`, [orgId, good.id], 'ADS_DRAFT_SUBMITTED');
          await refusedBy(`UPDATE crove_ads.ad_campaign_draft SET status = 'discarded' WHERE org_id = $1 AND id = $2`, [orgId, good.id], 'ADS_DRAFT_SUBMITTED');
          expect(await callAs(owner, 'ads/campaignDraft', { draftId: good.id })).toMatchObject({ body: { pendingProposalId: id } });
          // A rejected request sends it back to its author: editable again, and a new request is possible.
          expect((await reject(adminAccount, id)).status).toBe(200);
          const reopened = await saved(owner, account, plan({ dailyBudget: '90000' }), good.id);
          expect(reopened).toMatchObject({ revision: 2, maxSpend: '630000', pendingProposalId: null });
          proposalId(await submit(owner, good.id));
        });

        it('approves a plan like any money: the author does not approve it, the approver behind a second factor does, and then it is approved and frozen', async () => {
          const account = await ready('Duyệt kế hoạch');
          const draft = await saved(member, account, plan());
          const id = proposalId(await submit(owner, draft.id));
          // P10: the author does not approve it while another eligible person exists; P11: the approver needs a second factor.
          expect(await approve(owner, id)).toMatchObject({ status: 403, body: { code: 'FOUR_EYES_REQUIRED' } });
          expect(await approve(adminAccount, id, { mfa: false })).toMatchObject({ status: 403, body: { code: 'STEP_UP_REQUIRED' } });
          expect(await draftRow(draft.id)).toMatchObject({ status: 'draft', proposal_id: null, approved_at: null });
          expect((await approve(adminAccount, id)).status).toBe(200);
          expect(await draftRow(draft.id)).toMatchObject({ status: 'approved', proposal_id: id, max_spend: '700000' });
          expect((await draftRow(draft.id))?.approved_at).toBeInstanceOf(Date);
          expect(await callAs(owner, 'ads/campaignDraft', { draftId: draft.id })).toMatchObject({ body: { status: 'approved', issues: [], pendingProposalId: null } });
          // Approved is over: no edit, no discard, no second request; for the commands and for the database.
          expect(await save(owner, account, plan({ dailyBudget: '90000' }), draft.id)).toMatchObject({ status: 409, body: { code: 'ADS_DRAFT_CLOSED' } });
          expect((await callAs(owner, 'ads/discardCampaignDraft', { draftId: draft.id, idempotencyKey: key() })).status).toBe(409);
          expect((await submit(owner, draft.id)).status).toBe(409);
          await refusedBy(`UPDATE crove_ads.ad_campaign_draft SET daily_budget = 1 WHERE org_id = $1 AND id = $2`, [orgId, draft.id], 'ADS_DRAFT_FROZEN');
          // The audit row has the ids, the amount and the hash, never the creative text.
          const audit = await row<{ detail: Record<string, unknown> }>(`SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'ads.campaign.launch' AND outcome = 'ok' ORDER BY id DESC LIMIT 1`, [orgId]);
          expect(audit[0]?.detail).toMatchObject({ draftId: draft.id, maxSpend: '700000', currency: 'VND', days: 7, planHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) });
          expect(JSON.stringify(audit[0]?.detail)).not.toContain('Khuyến');
        });

        it('lets a draft become approved by that approved proposal alone: no raw status change, no forged row, no other draft', async () => {
          const account = await ready('Khóa cơ sở dữ liệu');
          const a = await saved(owner, account, plan());
          const b = await saved(owner, account, plan({ name: 'Một chiến dịch khác' }));
          // A raw statement cannot approve a draft or insert one that is approved, discarded or with a proposal, whoever runs it.
          await refusedBy(`UPDATE crove_ads.ad_campaign_draft SET status = 'approved', proposal_id = gen_random_uuid(), approved_at = now() WHERE org_id = $1 AND id = $2`, [orgId, a.id], 'ADS_DRAFT_FORBIDDEN');
          const forged = (columns: string, values: string) => refusedBy(`INSERT INTO crove_ads.ad_campaign_draft (org_id, ad_account_id, name, objective, created_by, ${columns}) VALUES ($1, $2, 'Giả', 'traffic', $3, ${values})`, [orgId, account, owner.userId], 'ADS_DRAFT_FORBIDDEN');
          await forged('status', `'discarded'`);
          await forged('proposal_id', 'gen_random_uuid()');
          await forged('revision', '5');
          // 'approved' with its proposal and its time is stopped by the guard too (the table's check alone would let a draft with both through).
          await forged('status, proposal_id, approved_at', `'approved', gen_random_uuid(), now()`);
          // The approval of one draft's proposal does not approve another: the guard names the draft, its revision and its amount.
          const id = proposalId(await submit(owner, a.id));
          expect((await approve(adminAccount, id)).status).toBe(200);
          expect((await draftRow(b.id))?.status).toBe('draft');
          // The writer cannot stamp who or when, or the revision: the database does, each on its own; who wrote it and the keys never change.
          await row(`UPDATE crove_ads.ad_campaign_draft SET revision = 99 WHERE org_id = $1 AND id = $2`, [orgId, b.id]);
          expect((await draftRow(b.id))?.revision).toBe(1);
          await row(`UPDATE crove_ads.ad_campaign_draft SET updated_by = $3 WHERE org_id = $1 AND id = $2`, [orgId, b.id, member.userId]);
          expect((await row<{ updated_by: string | null }>(`SELECT updated_by FROM crove_ads.ad_campaign_draft WHERE org_id = $1 AND id = $2`, [orgId, b.id]))[0]?.updated_by).toBeNull();
          await refusedBy(`UPDATE crove_ads.ad_campaign_draft SET created_at = '2000-01-01' WHERE org_id = $1 AND id = $2`, [orgId, b.id], 'ADS_DRAFT_FORBIDDEN');
          await refusedBy(`UPDATE crove_ads.ad_campaign_draft SET origin = 'ai' WHERE org_id = $1 AND id = $2`, [orgId, b.id], 'ADS_DRAFT_FORBIDDEN');
          await refusedBy(`UPDATE crove_ads.ad_campaign_draft SET ai_fields = ARRAY['dailyBudget'] WHERE org_id = $1 AND id = $2`, [orgId, b.id], 'ADS_DRAFT_FORBIDDEN');
          // No amount that is not a number: NaN and Infinity are refused by the table.
          await refusedBy(`UPDATE crove_ads.ad_campaign_draft SET daily_budget = 'NaN' WHERE org_id = $1 AND id = $2`, [orgId, b.id], 'ad_campaign_draft_daily_budget_check');
          await refusedBy(`UPDATE crove_ads.ad_campaign_draft SET max_spend = 'Infinity' WHERE org_id = $1 AND id = $2`, [orgId, b.id], 'ad_campaign_draft_max_spend_check');
          // A draft with no amount is never approved, even by a proposal that names it.
          await row(`UPDATE crove_ads.ad_campaign_draft SET max_spend = NULL WHERE org_id = $1 AND id = $2`, [orgId, b.id]);
          await refusedBy(`UPDATE crove_ads.ad_campaign_draft SET status = 'approved', proposal_id = gen_random_uuid(), approved_at = now() WHERE org_id = $1 AND id = $2`, [orgId, b.id], 'ADS_DRAFT_FORBIDDEN');
        });

        it('checks again at approval: a cap lowered, running ads switched off or launches blocked after the request stop the approval, and the draft stays a draft', async () => {
          const account = await ready('Kiểm tra lại khi duyệt');
          const lowered = await saved(owner, account, plan());
          const idLowered = proposalId(await submit(owner, lowered.id));
          // The owner lowers the org's daily cap under the plan's budget (a stop, direct): the approval refuses, with the reason.
          expect((await callAs(owner, 'ads/lowerCap', { idempotencyKey: key(), scope: 'org', period: 'daily', amount: '50000' })).status).toBe(200);
          expect(await approve(adminAccount, idLowered)).toMatchObject({ status: 409, body: { code: 'ADS_DRAFT_INVALID' } });
          expect(await draftRow(lowered.id)).toMatchObject({ status: 'draft', proposal_id: null });
          expect((await reject(adminAccount, idLowered)).status).toBe(200);
          // The kill switch: launches blocked refuses the request and an approval of one made before.
          const account2 = await ready('Chặn chạy');
          const blocked = await saved(owner, account2, plan({ dailyBudget: '40000' }));
          const idBlocked = proposalId(await submit(owner, blocked.id));
          expect((await callAs(adminAccount, 'ads/pauseAll', { idempotencyKey: key() })).status).toBe(200);
          expect(await approve(adminAccount, idBlocked)).toMatchObject({ status: 409, body: { code: 'ADS_DRAFT_INVALID' } });
          expect(await submit(owner, (await saved(owner, account2, plan({ name: 'Sau khi chặn', dailyBudget: '40000' }))).id)).toMatchObject({ status: 422, body: { code: 'ADS_DRAFT_INVALID' } });
          expect((await reject(adminAccount, idBlocked)).status).toBe(200);
          // Writing switched off after the request: the approval is refused, the draft stays a draft; and with it off, no request at all.
          const account3 = await ready('Tắt sau khi gửi');
          const off = await saved(owner, account3, plan({ dailyBudget: '40000' }));
          const idOff = proposalId(await submit(owner, off.id));
          expect((await callAs(owner, 'ads/writeDisable', { idempotencyKey: key() })).status).toBe(200);
          expect(await approve(adminAccount, idOff)).toMatchObject({ status: 409, body: { code: 'ADS_DRAFT_INVALID' } });
          expect(await draftRow(off.id)).toMatchObject({ status: 'draft', proposal_id: null });
          expect(await submit(owner, (await saved(owner, account3, plan({ name: 'Sau khi tắt', dailyBudget: '40000' }))).id)).toMatchObject({ status: 422, body: { code: 'ADS_DRAFT_INVALID' } });
          expect((await reject(adminAccount, idOff)).status).toBe(200);
        });

        it('lets an account move to another legal entity whatever state its drafts are in, and keeps the drafts with it', async () => {
          const account = await ready('Chuyển pháp nhân');
          const discarded = await saved(owner, account, plan());
          expect((await callAs(owner, 'ads/discardCampaignDraft', { draftId: discarded.id, idempotencyKey: key() })).status).toBe(200);
          const approved = await saved(owner, account, plan({ name: 'Đã duyệt' }));
          expect((await approve(adminAccount, proposalId(await submit(owner, approved.id)))).status).toBe(200);
          const open = await saved(owner, account, plan({ name: 'Đang soạn' }));
          const entity = (await row<{ id: string }>(`INSERT INTO crove_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, 'Chi nhánh quảng cáo', 'branch', $2) RETURNING id`, [orgId, owner.userId]))[0]?.id as string;
          const entityOf = async (id: string) => (await row<{ legal_entity_id: string; status: string }>(`SELECT legal_entity_id, status FROM crove_ads.ad_campaign_draft WHERE org_id = $1 AND id = $2`, [orgId, id]))[0];
          const before = (await entityOf(open.id))?.legal_entity_id;
          // The account's foreign key cascades the new entity to its drafts; the guard lets that alone through for a draft that is over too.
          await row(`UPDATE crove_ads.ad_account SET legal_entity_id = $3 WHERE org_id = $1 AND id = $2`, [orgId, account, entity]);
          expect(await entityOf(discarded.id)).toEqual({ legal_entity_id: entity, status: 'discarded' });
          expect(await entityOf(approved.id)).toEqual({ legal_entity_id: entity, status: 'approved' });
          expect((await entityOf(open.id))?.legal_entity_id).toBe(entity);
          await row(`UPDATE crove_ads.ad_account SET legal_entity_id = $3 WHERE org_id = $1 AND id = $2`, [orgId, account, before]);
          expect((await entityOf(approved.id))?.legal_entity_id).toBe(before);
          // A request made in one entity is not approved after its account moved to another: the approval is refused and a new request is the way.
          const asked = proposalId(await submit(owner, open.id));
          await row(`UPDATE crove_ads.ad_account SET legal_entity_id = $3 WHERE org_id = $1 AND id = $2`, [orgId, account, entity]);
          expect(await approve(adminAccount, asked)).toMatchObject({ status: 409, body: { code: 'ADS_DRAFT_CHANGED' } });
          expect((await draftRow(open.id))?.status).toBe('draft');
          await row(`UPDATE crove_ads.ad_account SET legal_entity_id = $3 WHERE org_id = $1 AND id = $2`, [orgId, account, before]);
          expect((await approve(adminAccount, asked)).status).toBe(200);
        });

        it('carries the AI taint of a draft to the request and holds it to the approval: who wrote the plan and which fields the AI coworker drafted', async () => {
          const account = await ready('Dấu AI');
          const body = plan({ name: 'Do đồng nghiệp AI soạn' });
          // A draft the system wrote (origin ai, the fields it drafted named), inserted as the database owner: the draft job's command does the same in the system context.
          const [made] = await row<{ id: string }>(
            `INSERT INTO crove_ads.ad_campaign_draft (org_id, ad_account_id, name, objective, daily_budget, start_on, end_on, targeting, link_url, variants, origin, ai_fields, max_spend, created_by)
             VALUES ($1, $2, $3, 'traffic', $4, $5, $6, $7::jsonb, $8, $9::jsonb, 'ai', ARRAY['name', 'targeting', 'variants'], $10, $11) RETURNING id`,
            [orgId, account, body.name, body.dailyBudget, body.startOn, body.endOn, JSON.stringify(body.targeting), body.linkUrl, JSON.stringify(body.variants), '700000', member.userId],
          );
          const id = made?.id as string;
          const asked = proposalId(await submit(owner, id));
          // The request names who wrote the plan and what the AI coworker drafted, for the approval card; a human's draft says none.
          const payload = async (proposal: string) => (await row<{ payload: { origin: string; aiFields: string[] } }>(`SELECT payload FROM crove_kernel.proposal WHERE org_id = $1 AND id = $2`, [orgId, proposal]))[0]?.payload;
          expect(await payload(asked)).toMatchObject({ origin: 'ai', aiFields: ['name', 'targeting', 'variants'] });
          // The card reads it too: ads.proposal.change names the origin and the fields, for the Inbox card to say the plan is AI-written.
          expect((await callAs(owner, 'ads/proposal', { id: asked })).body).toMatchObject({ change: { change: 'campaign_launch', draftId: id, origin: 'ai', aiFields: ['name', 'targeting', 'variants'] } });
          const human = await saved(owner, account, plan({ name: 'Của người' }));
          expect(await payload(proposalId(await submit(owner, human.id)))).toMatchObject({ origin: 'human', aiFields: [] });
          // The draft is frozen while the request waits, so the taint at the approval is the taint on the card: the approval goes through.
          expect((await approve(adminAccount, asked)).status).toBe(200);
          expect(await draftRow(id)).toMatchObject({ status: 'approved' });
        });

        it('keeps the drafts of another org out, and answers for an account of the org only', async () => {
          const account = await ready('Hai tổ chức');
          const mine = await saved(owner, account, plan());
          expect((await rpc('ads/campaignDraft', await tokenFor(outsider), { draftId: mine.id }, otherSlug)).status).toBe(404);
          expect(((await rpc('ads/campaignDrafts', await tokenFor(outsider), {}, otherSlug)).body as unknown[]).length).toBe(0);
          expect((await rpc('ads/saveCampaignDraft', await tokenFor(outsider), { idempotencyKey: key(), adAccountId: account, plan: plan() }, otherSlug)).status).toBe(404);
          expect((await save(owner, randomUUID(), plan())).status).toBe(404);
        });

        // W2-2 (#2296): the launch ledger. An approved plan leaves a row that holds its amount against the caps; the caps are judged against every launch that still
        // commits, under the org's lock; a person cancels one that has not started; the stops release them. Nothing launches (no queue, no job, no platform call).
        const launchOf = async (draftId: string) =>
          (
            await row<{ id: string; state: string; step: string | null; attempt: number; currency: string; daily_budget: string; amount: string; start_on: string; end_on: string; commit_until: string | null; tag: string; proposal_id: string; plan_hash: string; created_by: string; stop_reason: string | null; finished_at: Date | null }>(
              `SELECT id, state, step, attempt, currency, daily_budget::text, amount::text, start_on::text, end_on::text, commit_until::text, tag, proposal_id, plan_hash, created_by, stop_reason, finished_at FROM crove_ads.ad_launch WHERE org_id = $1 AND draft_id = $2`,
              [orgId, draftId],
            )
          )[0];
        // Saves, submits and approves a plan; answers the draft and the approval's answer.
        const approvedPlan = async (account: string, body: Record<string, unknown>) => {
          const draft = await saved(owner, account, plan(body));
          const id = proposalId(await submit(owner, draft.id));
          return { draft, id, answer: await approve(adminAccount, id) };
        };

        it('queues the approved plan as a launch that holds its amount: the window, the tag, the approver, the hash, ids only in the audit, and nothing launched', async () => {
          const account = await ready('Sổ cái');
          const { draft, id, answer } = await approvedPlan(account, {});
          expect(answer.status).toBe(200);
          const launch = await launchOf(draft.id);
          expect(launch).toMatchObject({ state: 'queued', step: null, attempt: 1, currency: 'VND', daily_budget: '100000', amount: '700000', start_on: inDays(2), end_on: inDays(8), commit_until: inDays(8), proposal_id: id, created_by: adminAccount.userId, stop_reason: null, finished_at: null });
          expect(launch?.tag).toMatch(/^ludy:[0-9a-f]{10}$/);
          expect(launch?.plan_hash).toBe((await row<{ h: string }>(`SELECT payload ->> 'planHash' AS h FROM crove_kernel.proposal WHERE org_id = $1 AND id = $2`, [orgId, id]))[0]?.h);
          // The draft shows it, in the list and alone.
          expect((await callAs(owner, 'ads/campaignDraft', { draftId: draft.id })).body).toMatchObject({ status: 'approved', launch: { id: launch?.id, state: 'queued', amount: '700000', commitUntil: inDays(8), tag: launch?.tag } });
          expect(((await callAs(owner, 'ads/campaignDrafts', { adAccountId: account })).body as Array<{ id: string; launch: { id: string } | null }>).find((d) => d.id === draft.id)?.launch?.id).toBe(launch?.id);
          expect((await callAs(owner, 'ads/campaignDraft', { draftId: (await saved(owner, account, plan({ name: 'Chưa duyệt' }))).id })).body).toMatchObject({ launch: null });
          // The audit row has ids, the amount and the hash, never the creative text, and nothing was sent anywhere.
          const audit = await row<{ detail: Record<string, unknown> }>(`SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'ads.campaign.launch' AND outcome = 'ok' ORDER BY id DESC LIMIT 1`, [orgId]);
          expect(audit[0]?.detail).toMatchObject({ draftId: draft.id, launchId: launch?.id, maxSpend: '700000' });
          expect(JSON.stringify(audit[0]?.detail)).not.toContain('Khuyến');
          expect((await row<{ n: string }>(`SELECT count(*)::text AS n FROM crove_kernel.external_call WHERE org_id = $1`, [orgId]))[0]?.n).toBe('0');
          // The approval ran under the approval rules of version 4, judged on the people of the org now: two eligible people, so the approver is not the author.
          const approval = (await row<{ detail: { policy_version: number; eligible_approvers: number; self_approved: boolean; policy: Record<string, string> } }>(`SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'kernel.proposal.approve' AND outcome = 'ok' ORDER BY id DESC LIMIT 1`, [orgId]))[0]?.detail;
          expect(approval).toMatchObject({ policy_version: 4, self_approved: false, policy: { P12: 'pass', P10: 'pass' } });
          expect(approval?.eligible_approvers).toBeGreaterThanOrEqual(2);
        });

        it('judges a plan against every launch that still commits, with the numbers: at the request as a warning and at the approval as the check, and a cancel releases it', async () => {
          // Both accounts first: each `ready` releases what the tests before left queued, which must not reach the launches below.
          const account = await ready('Hạn mức cộng dồn');
          const elsewhere = await ready('Tài khoản khác cùng tổ chức');
          // Each of the two plans fits the org's daily cap of 200 000 alone (150 000 a day); together they do not.
          const first = await approvedPlan(account, { dailyBudget: '150000' });
          expect(first.answer.status).toBe(200);
          const second = await saved(owner, account, plan({ name: 'Chiến dịch thứ hai', dailyBudget: '150000' }));
          // Early: the request itself says so, and asks the approver for nothing.
          const early = await submit(owner, second.id);
          expect(early).toMatchObject({ status: 409, body: { code: 'ADS_SPEND_CAP', data: { problems: [expect.objectContaining({ code: 'daily_cap_exceeded', scope: 'org', cap: '200000', committed: '150000', plan: '150000', day: inDays(2) })] } } });
          // Authoritative: a request made before the first was approved is refused at its own approval, with the same numbers, and stays waiting.
          const third = await saved(owner, account, plan({ name: 'Chiến dịch thứ ba', dailyBudget: '150000', startOn: inDays(20), endOn: inDays(26) }));
          const idThird = proposalId(await submit(owner, third.id));
          const fourth = await saved(owner, account, plan({ name: 'Chiến dịch thứ tư', dailyBudget: '150000', startOn: inDays(20), endOn: inDays(26) }));
          const idFourth = proposalId(await submit(owner, fourth.id));
          expect((await approve(adminAccount, idThird)).status).toBe(200);
          expect(await approve(adminAccount, idFourth)).toMatchObject({ status: 409, body: { code: 'ADS_SPEND_CAP' } });
          expect(await draftRow(fourth.id)).toMatchObject({ status: 'draft', proposal_id: null });
          expect(await launchOf(fourth.id)).toBeUndefined();
          // A launch of another account counts too (the org's cap counts every account), in the days it covers.
          const first2 = await approvedPlan(elsewhere, { dailyBudget: '150000', startOn: inDays(40), endOn: inDays(41) });
          expect(first2.answer.status).toBe(200);
          const sameDays = await saved(owner, account, plan({ name: 'Trùng ngày với tài khoản khác', dailyBudget: '100000', startOn: inDays(40), endOn: inDays(41) }));
          expect(await submit(owner, sameDays.id)).toMatchObject({ status: 409, body: { code: 'ADS_SPEND_CAP' } });
          // Cancelling the first launch releases its amount at once: the refused plan now goes through.
          const firstLaunch = (await launchOf(first.draft.id))?.id as string;
          expect(await callAs(owner, 'ads/cancelLaunch', { launchId: firstLaunch, idempotencyKey: key() })).toMatchObject({ status: 200, body: { launchId: firstLaunch, released: '1050000' } });
          expect(await approve(adminAccount, proposalId(await submit(owner, second.id)))).toMatchObject({ status: 200 });
          expect(await launchOf(second.id)).toMatchObject({ state: 'queued', amount: '1050000' });
        });

        it('serialises launches approved at the same moment: the commitments never pass a cap between them', async () => {
          const account = await ready('Duyệt cùng lúc');
          // Five plans of 100 000 a day on the same days: any two fit the daily cap of 200 000, no three do. All five are asked for while none is approved.
          const ids: Array<{ draft: string; proposal: string }> = [];
          for (let n = 1; n <= 5; n += 1) {
            const draft = await saved(owner, account, plan({ name: `Song song ${n}` }));
            ids.push({ draft: draft.id, proposal: proposalId(await submit(owner, draft.id)) });
          }
          const answers = await Promise.all(ids.map((i) => approve(adminAccount, i.proposal)));
          expect(answers.filter((a) => a.status === 200)).toHaveLength(2);
          expect(answers.filter((a) => a.status === 409).map((a) => a.body.code)).toEqual(['ADS_SPEND_CAP', 'ADS_SPEND_CAP', 'ADS_SPEND_CAP']);
          const queued = await row<{ n: string }>(`SELECT count(*)::text AS n FROM crove_ads.ad_launch WHERE org_id = $1 AND state = 'queued'`, [orgId]);
          expect(queued[0]?.n).toBe('2');
          // Whatever the order they ran in, no day of the org commits more than the cap.
          const over = await row<{ day: string; total: string }>(
            `SELECT d::date::text AS day, sum(l.daily_budget)::text AS total FROM crove_ads.ad_launch l, generate_series(l.start_on, l.commit_until, interval '1 day') d
             WHERE l.org_id = $1 AND l.commit_until IS NOT NULL GROUP BY 1 HAVING sum(l.daily_budget) > 200000`,
            [orgId],
          );
          expect(over).toEqual([]);
          for (const i of ids) {
            if ((await draftRow(i.draft))?.status !== 'approved') expect((await reject(adminAccount, i.proposal)).status).toBe(200);
          }
        });

        it('lets an owner or an admin cancel a launch that has not started, and nobody else; a started one is the stop’s, and the draft stays approved', async () => {
          const account = await ready('Hủy lần chạy');
          const { draft } = await approvedPlan(account, {});
          const launch = (await launchOf(draft.id))?.id as string;
          for (const who of [member, viewer, accountant, outsider]) expect((await callAs(who, 'ads/cancelLaunch', { launchId: launch, idempotencyKey: key() })).status, who.email).toBe(403);
          expect((await callAs(owner, 'ads/cancelLaunch', { launchId: randomUUID(), idempotencyKey: key() })).status).toBe(404);
          // The system does not cancel through the command (an owner's or an admin's).
          await expect(api.execute('ads.launch.cancel', { launchId: launch }, { actor: SYSTEM, orgId })).rejects.toBeTruthy();
          // A launch the writer has started (the system's move, W2-3) is not cancelled by this command.
          await inContext('system', (c) => c.query(`UPDATE crove_ads.ad_launch SET state = 'launching', step = 'campaign' WHERE org_id = $1 AND id = $2`, [orgId, launch]), true);
          expect(await callAs(adminAccount, 'ads/cancelLaunch', { launchId: launch, idempotencyKey: key() })).toMatchObject({ status: 409, body: { code: 'ADS_LAUNCH_NOT_QUEUED' } });
          await inContext('system', (c) => c.query(`UPDATE crove_ads.ad_launch SET state = 'stopped', commit_until = NULL WHERE org_id = $1 AND id = $2`, [orgId, launch]), true);
          const second = await approvedPlan(account, { name: 'Lần thứ hai' });
          const secondLaunch = (await launchOf(second.draft.id))?.id as string;
          expect(await callAs(adminAccount, 'ads/cancelLaunch', { launchId: secondLaunch, idempotencyKey: key() })).toMatchObject({ status: 200, body: { launchId: secondLaunch, released: '700000' } });
          expect(await launchOf(second.draft.id)).toMatchObject({ state: 'cancelled', commit_until: null, stop_reason: 'cancelled' });
          expect((await launchOf(second.draft.id))?.finished_at).toBeInstanceOf(Date);
          expect(await callAs(adminAccount, 'ads/cancelLaunch', { launchId: secondLaunch, idempotencyKey: key() })).toMatchObject({ status: 409, body: { code: 'ADS_LAUNCH_NOT_QUEUED' } });
          // The plan is over (approved, never edited again), and its draft shows the cancelled launch.
          expect((await callAs(owner, 'ads/campaignDraft', { draftId: second.draft.id })).body).toMatchObject({ status: 'approved', launch: { state: 'cancelled', commitUntil: null } });
          const audit = await row<{ detail: Record<string, unknown> }>(`SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'ads.launch.cancel' AND outcome = 'ok' ORDER BY id DESC LIMIT 1`, [orgId]);
          expect(audit[0]?.detail).toMatchObject({ launchId: secondLaunch, amount: '700000', cancelled: true });
        });

        it('releases the launches that have not started when the stops run: an account’s switch-off its own, the kill switch and the switch-off the org’s', async () => {
          const a = await ready('Dừng một tài khoản');
          const b = await ready('Dừng tài khoản kia');
          const onA = await approvedPlan(a, { name: 'Trên A' });
          const onB = await approvedPlan(b, { name: 'Trên B' });
          expect([onA.answer.status, onB.answer.status]).toEqual([200, 200]);
          // Switching one account off cancels its own queued launches and leaves the other's.
          expect(await callAs(owner, 'ads/disableAccountWrite', { adAccountId: a, idempotencyKey: key() })).toMatchObject({ status: 200 });
          expect(await launchOf(onA.draft.id)).toMatchObject({ state: 'cancelled', commit_until: null, stop_reason: 'account_off' });
          expect(await launchOf(onB.draft.id)).toMatchObject({ state: 'queued', commit_until: inDays(8) });
          // The kill switch blocks launches and releases what had not started.
          expect((await callAs(adminAccount, 'ads/pauseAll', { idempotencyKey: key() })).status).toBe(200);
          expect(await launchOf(onB.draft.id)).toMatchObject({ state: 'cancelled', commit_until: null, stop_reason: 'launches_blocked' });
          // Disconnecting an account releases its queued launches too, so a plan approved before cannot start after a reconnect.
          const d = await ready('Ngắt kết nối');
          const onD = await approvedPlan(d, { name: 'Trên D' });
          expect(onD.answer.status).toBe(200);
          expect(await callAs(adminAccount, 'ads/disconnectAccount', { adAccountId: d, idempotencyKey: key() })).toMatchObject({ status: 200 });
          expect(await launchOf(onD.draft.id)).toMatchObject({ state: 'cancelled', commit_until: null, stop_reason: 'account_off' });
          // Switching writing off cancels the queued launches of every account.
          const c = await ready('Tắt cả tổ chức');
          const onC = await approvedPlan(c, { name: 'Trên C' });
          expect(onC.answer.status).toBe(200);
          expect((await callAs(owner, 'ads/writeDisable', { idempotencyKey: key() })).status).toBe(200);
          expect(await launchOf(onC.draft.id)).toMatchObject({ state: 'cancelled', commit_until: null, stop_reason: 'switch_off' });
          const audits = await row<{ detail: { launchesCancelled?: number } }>(`SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command IN ('ads.write.disable', 'ads.pause_all', 'ads.account.disable_write', 'ads.account.disconnect') AND outcome = 'ok' ORDER BY id DESC LIMIT 4`, [orgId]);
          expect(audits.map((x) => x.detail.launchesCancelled)).toEqual([1, 1, 1, 1]);
        });

        it('keeps a launch’s commitment when a cap is lowered after the approval, and judges the next plan against the lowered cap and what is committed', async () => {
          const account = await ready('Hạ hạn mức sau khi duyệt');
          const { draft } = await approvedPlan(account, { dailyBudget: '150000' });
          expect((await callAs(owner, 'ads/lowerCap', { idempotencyKey: key(), scope: 'org', period: 'daily', amount: '160000' })).status).toBe(200);
          // The approved launch keeps its commitment (W2-3 re-reads the caps before its first platform call); a plan of 20 000 a day on the same days passes 160 000.
          expect((await launchOf(draft.id))?.commit_until).toBe(inDays(8));
          const small = await saved(owner, account, plan({ name: 'Nhỏ', dailyBudget: '20000' }));
          expect(await submit(owner, small.id)).toMatchObject({ status: 409, body: { code: 'ADS_SPEND_CAP' } });
          const fits = await saved(owner, account, plan({ name: 'Vừa đủ', dailyBudget: '10000' }));
          expect((await submit(owner, fits.id)).status).toBe(200);
        });

        // W2-3 (#2296): the launch job. It creates the plan's objects at the platform (here the sandbox writer, in memory), every one PAUSED, exactly once, and a
        // launch ends as objects created and paused: nothing in this slice un-pauses anything.
        describe('the launch job (W2-3)', () => {
          const ORDER = ['campaign', 'ad_set', 'creative_1', 'ad_1', 'creative_2', 'ad_2', 'creative_3', 'ad_3'];
          const variant = (n: number) => ({ headline: `Tiêu đề ${n}`, primaryText: `Nội dung quảng cáo số ${n}`, callToAction: 'learn_more' });
          // A Facebook Page of the org, which the ads run as.
          const pageConnection = async () => {
            const id = randomUUID();
            const external = String(100_000_000 + Math.floor(Math.random() * 899_999_999));
            await row(`INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, 'facebook_page', $3, 'Trang thử', $4)`, [orgId, id, external, owner.userId]);
            return { id, external };
          };
          // An account that can run ads, with the sandbox's write connection, and an approved plan whose launch is queued.
          const queued = async (name: string, over: Record<string, unknown> = {}, withPage = true) => {
            const account = await ready(name);
            const done = await callAs(owner, 'ads/connectSandboxWrite', { adAccountId: account, idempotencyKey: key() });
            expect(done.status, JSON.stringify(done.body)).toBe(200);
            const page = withPage ? await pageConnection() : null;
            const approved = await approvedPlan(account, { ...(page ? { pageConnectionId: page.id } : {}), ...over });
            expect(approved.answer.status, JSON.stringify(approved.answer.body)).toBe(200);
            const launch = (await launchOf(approved.draft.id)) as NonNullable<Awaited<ReturnType<typeof launchOf>>>;
            return { account, page, draft: approved.draft, launch };
          };
          const run = (writers: SandboxAdWriter | Readonly<Record<string, LaunchWriter>>, launchId: string, runtime: Runtime = worker) =>
            runAdsLaunch({ runtime, broker: vault, writers: writers instanceof SandboxAdWriter ? adLaunchWriters({ sandbox: writers }) : writers }, { orgId, launchId });
          const launchNow = async (id: string) => (await row<{ state: string; step: string | null; attempt: number; commit_until: string | null; stop_reason: string | null; finished_at: Date | null }>(`SELECT state, step, attempt, commit_until::text, stop_reason, finished_at FROM crove_ads.ad_launch WHERE org_id = $1 AND id = $2`, [orgId, id]))[0];
          const calls = async (id: string) => {
            const found = await row<{ key: string; step: string; state: string; calls: number; external_ref: string | null; error_kind: string | null; error_code: string | null }>(
              `SELECT key, step, state, calls, external_ref, error_kind, error_code FROM crove_kernel.external_call WHERE org_id = $1 AND key LIKE $2`,
              [orgId, `ads.launch:${id}:%`],
            );
            return found.sort((a, b) => ORDER.indexOf(a.step) - ORDER.indexOf(b.step));
          };
          const objectsOf = async (id: string) => (await row<{ slot: string; level: string; external_id: string; name: string; configured_status: string }>(`SELECT slot, level, external_id, name, configured_status FROM crove_ads.ad_object WHERE org_id = $1 AND launch_id = $2`, [orgId, id])).sort((a, b) => ORDER.indexOf(a.slot) - ORDER.indexOf(b.slot));
          // The clock of a call the job began, put back (a dead worker, a minute that passed), as the Social publish tests do.
          const age = (id: string, seconds: number) =>
            row(`UPDATE crove_kernel.external_call SET updated_at = updated_at - make_interval(secs => $3) WHERE org_id = $1 AND key LIKE $2 AND state IN ('started', 'ambiguous')`, [orgId, `ads.launch:${id}:%`, seconds]);
          // Writing is switched off again when these tests are done, which closes the write connections they made (the tests that follow count them).
          afterAll(async () => {
            await callAs(owner, 'ads/writeDisable', { idempotencyKey: key() });
          });
          // A writer that remembers what it was asked to create an ad set with.
          class Spy extends SandboxAdWriter {
            readonly adSets: Parameters<SandboxAdWriter['createAdSet']>[2][] = [];
            readonly creatives: Parameters<SandboxAdWriter['createCreative']>[2][] = [];
            readonly ads: Parameters<SandboxAdWriter['createAd']>[2][] = [];
            override async createAdSet(secret: string, account: Parameters<SandboxAdWriter['createAdSet']>[1], input: Parameters<SandboxAdWriter['createAdSet']>[2]) {
              this.adSets.push(input);
              return super.createAdSet(secret, account, input);
            }
            override async createCreative(secret: string, account: Parameters<SandboxAdWriter['createCreative']>[1], input: Parameters<SandboxAdWriter['createCreative']>[2]) {
              this.creatives.push(input);
              return super.createCreative(secret, account, input);
            }
            override async createAd(secret: string, account: Parameters<SandboxAdWriter['createAd']>[1], input: Parameters<SandboxAdWriter['createAd']>[2]) {
              this.ads.push(input);
              return super.createAd(secret, account, input);
            }
          }

          it('creates the plan\'s objects at the platform, every one paused, one call each, records their ids and the tag, and ends as created and paused: nothing is activated', async () => {
            const w = new Spy();
            const { launch, page, draft } = await queued('Tạo đối tượng', { variants: [variant(1), variant(2)], targeting: { locations: [{ country: 'VN' }, { country: 'VN', region: 'Hà Nội' }], ageMin: 22, ageMax: 45, gender: 'female', interests: ['Cà phê'] } });
            expect(launch.state).toBe('queued');
            // The approval wrote the event that queues the job: ids only.
            const event = await row<{ payload: Record<string, unknown> }>(`SELECT payload FROM crove_kernel.outbox_event WHERE org_id = $1 AND type = 'ads.launch.queued' AND payload ->> 'launchId' = $2`, [orgId, launch.id]);
            expect(event.map((e) => Object.keys(e.payload).sort())).toEqual([['adAccountId', 'launchId']]);
            expect(await run(w, launch.id)).toEqual({ steps: 6, ended: 'paused' });
            // Six objects, in the order the plan makes them, every one paused, each name carrying the launch's tag; no object was ever anything else.
            expect(w.received).toEqual(['campaign', 'ad_set', 'creative', 'ad', 'creative', 'ad']);
            expect([...w.objects.values()].map((o) => o.status)).toEqual(Array(6).fill('paused'));
            expect([...w.objects.values()].every((o) => o.name.includes(launch.tag))).toBe(true);
            const objects = await objectsOf(launch.id);
            expect(objects.map((o) => [o.slot, o.level, o.configured_status])).toEqual([['campaign', 'campaign', 'paused'], ['ad_set', 'ad_set', 'paused'], ['creative_1', 'creative', 'paused'], ['ad_1', 'ad', 'paused'], ['creative_2', 'creative', 'paused'], ['ad_2', 'ad', 'paused']]);
            expect(objects.map((o) => o.external_id).sort()).toEqual([...w.objects.keys()].sort());
            expect(objects.every((o) => o.name.includes(launch.tag))).toBe(true);
            // One ledger row per call, keyed by launch, attempt and step, called once each, with the platform's id.
            const ledger = await calls(launch.id);
            expect(ledger.map((c) => [c.key, c.state, c.calls])).toEqual(ORDER.slice(0, 6).map((step) => [`ads.launch:${launch.id}:1:${step}`, 'succeeded', 1]));
            expect(ledger.map((c) => c.external_ref)).toEqual(objects.map((o) => o.external_id));
            // The launch ends created and paused, its commitment kept (W2-4 activates it); the draft stays approved.
            expect(await launchNow(launch.id)).toMatchObject({ state: 'launching', step: 'paused', attempt: 1, commit_until: inDays(8), stop_reason: null, finished_at: null });
            expect((await draftRow(draft.id))?.status).toBe('approved');
            // What the job sent: the budget as the ledger holds it, the flight in the account's zone, the targeting as the platform's ids, the Page and the texts.
            const set = w.adSets[0];
            expect(set).toMatchObject({ dailyBudget: '100000', startTime: `${inDays(2)}T00:00:00+0700`, endTime: `${inDays(9)}T00:00:00+0700`, pageId: page?.external, objective: 'traffic' });
            expect(set?.targeting).toMatchObject({ countries: ['VN'], ageMin: 22, ageMax: 45, gender: 'female' });
            expect(set?.targeting.regions).toEqual([{ key: expect.stringMatching(/^sbxr-/), name: 'Hà Nội' }]);
            expect(set?.targeting.interests).toEqual([{ id: expect.stringMatching(/^sbxi-/), name: 'Cà phê' }]);
            expect(w.creatives.map((c) => [c.headline, c.primaryText, c.callToAction, c.linkUrl, c.pageId])).toEqual([1, 2].map((n) => [`Tiêu đề ${n}`, `Nội dung quảng cáo số ${n}`, 'learn_more', 'https://example.com/khuyen-mai', page?.external]));
            expect(w.ads).toHaveLength(2);
            // A second run finds nothing to do and calls nothing.
            expect(await run(w, launch.id)).toEqual({ steps: 0, ended: 'paused' });
            expect(w.received).toHaveLength(6);
            // The token is in no audit row, event, ledger row or answer, and the plan's texts are in no audit row.
            const leaks = await row<{ n: string }>(
              `SELECT (SELECT count(*) FROM crove_kernel.audit_event WHERE org_id = $1 AND (detail::text LIKE '%sbxw_%' OR detail::text LIKE '%Nội dung quảng cáo%' OR detail::text LIKE '%Tiêu đề%'))
                    + (SELECT count(*) FROM crove_kernel.outbox_event WHERE org_id = $1 AND payload::text LIKE '%sbxw_%')
                    + (SELECT count(*) FROM crove_kernel.external_call WHERE org_id = $1 AND (key || coalesce(external_ref, '') || coalesce(error_code, '')) LIKE '%sbxw_%') AS n`,
              [orgId],
            );
            expect(leaks[0]?.n).toBe('0');
            const audited = await row<{ command: string }>(`SELECT DISTINCT command FROM crove_kernel.audit_event WHERE org_id = $1 AND command LIKE 'ads.launch.%'`, [orgId]);
            expect(audited.map((a) => a.command)).toEqual(expect.arrayContaining(['ads.launch.begin', 'ads.launch.record']));
          });

          it('is the system\'s alone: no owner, admin, member or agent runs begin or record', async () => {
            const { launch } = await queued('Chỉ hệ thống');
            const begin = { launchId: launch.id, writers: [] };
            const record = { launchId: launch.id, callKey: `ads.launch:${launch.id}:1:campaign`, phase: 'call', result: { kind: 'accepted', externalId: 'x1' } };
            for (const who of [asOwner(), { type: 'user' as const, userId: adminAccount.userId, aal: 'aal1' as const, sessionId: randomUUID() }, { type: 'user' as const, userId: member.userId, aal: 'aal1' as const, sessionId: randomUUID() }]) {
              await expect(api.execute('ads.launch.begin', begin, { actor: who, orgId })).rejects.toMatchObject({ status: 403 });
              await expect(api.execute('ads.launch.record', record, { actor: who, orgId })).rejects.toMatchObject({ status: 403 });
            }
            expect((await launchNow(launch.id))?.state).toBe('queued');
          });

          it('never creates an object twice: a platform answer that was lost after the object was made is reconciled by the launch\'s tag, and the found object is the one recorded', async () => {
            const w = new SandboxAdWriter();
            const { launch } = await queued('Mất câu trả lời');
            w.inject({ level: 'ad_set', when: 'after' });
            // The campaign is made; the ad set is made at the platform and its answer is lost: the row is unclear, the launch stays where it was.
            expect(await run(w, launch.id)).toEqual({ steps: 2, ended: 'unknown' });
            expect(await calls(launch.id)).toMatchObject([{ step: 'campaign', state: 'succeeded' }, { step: 'ad_set', state: 'ambiguous', calls: 1, error_kind: 'transient', error_code: 'NETWORK' }]);
            expect(await launchNow(launch.id)).toMatchObject({ state: 'launching', step: 'campaign' });
            expect(await objectsOf(launch.id)).toHaveLength(1);
            // The platform has had no time to show it: nothing is called, nothing is created.
            expect(await run(w, launch.id)).toEqual({ steps: 0, ended: 'reconcile_wait' });
            expect(w.received).toEqual(['campaign', 'ad_set']);
            // A minute later the next run asks the platform by the tag, finds the ad set, records it, and goes on: no second ad set.
            await age(launch.id, 61);
            expect(await run(w, launch.id)).toEqual({ steps: 3, ended: 'paused' });
            expect(w.received).toEqual(['campaign', 'ad_set', 'creative', 'ad']);
            expect([...w.objects.values()].map((o) => o.level)).toEqual(['campaign', 'ad_set', 'creative', 'ad']);
            const found = [...w.objects.values()].find((o) => o.level === 'ad_set');
            expect(await calls(launch.id)).toMatchObject([{ step: 'campaign', calls: 1 }, { step: 'ad_set', state: 'succeeded', calls: 1, external_ref: found?.id }, { step: 'creative_1', calls: 1 }, { step: 'ad_1', calls: 1 }]);
            expect((await objectsOf(launch.id)).find((o) => o.slot === 'ad_set')?.external_id).toBe(found?.id);
          });

          it('never creates an object twice when the worker dies between the platform\'s answer and the record: the begun call is left, found by the tag once it is old enough to be lost', async () => {
            const w = new SandboxAdWriter();
            const { launch } = await queued('Worker chết');
            // The record never happens: the process is gone after the platform made the campaign.
            const dying = new Proxy(worker, {
              get: (target, prop) => {
                if (prop === 'execute') {
                  return async (name: string, input: never, options: never) => {
                    if (name === 'ads.launch.record') throw new Error('process killed');
                    return target.execute(name, input, options);
                  };
                }
                const member = Reflect.get(target, prop, target) as unknown;
                return typeof member === 'function' ? (member as (...args: unknown[]) => unknown).bind(target) : member;
              },
            });
            await expect(run(w, launch.id, dying)).rejects.toThrow('process killed');
            expect(w.objects.size).toBe(1);
            expect(await calls(launch.id)).toMatchObject([{ step: 'campaign', state: 'started', calls: 1 }]);
            expect(await objectsOf(launch.id)).toEqual([]);
            // Straight away the call may still be in flight: nothing is called.
            expect(await run(w, launch.id)).toEqual({ steps: 0, ended: 'in_flight' });
            expect(w.received).toEqual(['campaign']);
            // Old enough to be lost: found by the tag, recorded, and the launch goes on. The campaign exists once.
            await age(launch.id, 301);
            expect(await run(w, launch.id)).toEqual({ steps: 4, ended: 'paused' });
            expect(w.received).toEqual(['campaign', 'ad_set', 'creative', 'ad']);
            expect([...w.objects.values()].filter((o) => o.level === 'campaign')).toHaveLength(1);
            expect((await calls(launch.id))[0]).toMatchObject({ step: 'campaign', state: 'succeeded', calls: 1, external_ref: [...w.objects.keys()][0] });
          });

          it('makes the call again, once, when reconcile finds that the object was never made: the row counts one call more', async () => {
            const w = new SandboxAdWriter();
            const { launch } = await queued('Chưa tạo');
            w.inject({ level: 'campaign', when: 'before' });
            expect(await run(w, launch.id)).toEqual({ steps: 1, ended: 'unknown' });
            expect(w.objects.size).toBe(0);
            await age(launch.id, 61);
            expect(await run(w, launch.id)).toEqual({ steps: 4, ended: 'paused' });
            expect(w.received).toEqual(['campaign', 'campaign', 'ad_set', 'creative', 'ad']);
            expect([...w.objects.values()].filter((o) => o.level === 'campaign')).toHaveLength(1);
            expect((await calls(launch.id))[0]).toMatchObject({ step: 'campaign', state: 'succeeded', calls: 2 });
          });

          it('lets only one job make the call again when two reconcile the same unclear step at the same moment: the other finds the step taken, and a second "missing" is stale', async () => {
            const w = new SandboxAdWriter();
            const { launch } = await queued('Hai job cùng đối soát');
            w.inject({ level: 'campaign', when: 'before' });
            expect(await run(w, launch.id)).toEqual({ steps: 1, ended: 'unknown' });
            await age(launch.id, 61);
            // Two jobs at once: one reconciles, finds nothing and makes the call; the other finds the step taken. The campaign exists once.
            await Promise.all([run(w, launch.id), run(w, launch.id)]);
            expect(w.received.filter((l) => l === 'campaign')).toHaveLength(2);
            expect([...w.objects.values()].filter((o) => o.level === 'campaign')).toHaveLength(1);
            expect((await calls(launch.id))[0]).toMatchObject({ step: 'campaign', state: 'succeeded', calls: 2 });
            // By hand, on a second launch: the begin that takes the step is the only one that is handed the reconcile, and a second "missing" for it is refused.
            const w2 = new SandboxAdWriter();
            const again = await queued('Missing hai lần');
            w2.inject({ level: 'campaign', when: 'before' });
            await run(w2, again.launch.id);
            await age(again.launch.id, 61);
            const writers = [{ provider: 'sandboxwrite_ads', objectives: ['traffic', 'engagement', 'messenger'], currencies: null, media: true }];
            const options = { actor: SYSTEM, orgId };
            const first = await worker.execute<{ action: string; callKey: string; step: string }>('ads.launch.begin', { launchId: again.launch.id, writers }, options);
            expect(first).toMatchObject({ action: 'reconcile', step: 'campaign' });
            expect(await worker.execute('ads.launch.begin', { launchId: again.launch.id, writers }, options)).toEqual({ action: 'none', reason: 'reconcile_wait' });
            const missing = { launchId: again.launch.id, callKey: first.callKey, phase: 'reconcile', result: { kind: 'missing' } };
            expect(await worker.execute('ads.launch.record', missing, options)).toMatchObject({ recorded: true, next: 'call' });
            expect(await worker.execute('ads.launch.record', missing, options)).toEqual({ recorded: false, reason: 'stale' });
            expect((await calls(again.launch.id))[0]).toMatchObject({ step: 'campaign', state: 'started', calls: 2 });
          });

          it('tells a person instead of guessing when a name cannot be told apart: two objects with the step\'s tail, or one with the tag and a name the platform changed, and nothing is created', async () => {
            // Two objects that carry this step's tail.
            const w = new SandboxAdWriter();
            const first = await queued('Hai đối tượng cùng tên');
            w.inject({ level: 'campaign', when: 'after' });
            expect(await run(w, first.launch.id)).toEqual({ steps: 1, ended: 'unknown' });
            const made = [...w.objects.values()][0] as NonNullable<ReturnType<SandboxAdWriter['objects']['get']>>;
            w.objects.set('sbx-copy-1', { ...made, id: 'sbx-copy-1' });
            await age(first.launch.id, 61);
            expect(await run(w, first.launch.id)).toEqual({ steps: 1, ended: 'unknowable' });
            expect(await launchNow(first.launch.id)).toMatchObject({ state: 'needs_attention', stop_reason: 'reconcile_unclear', commit_until: inDays(8) });
            expect(w.received).toEqual(['campaign']);
            expect((await calls(first.launch.id))[0]).toMatchObject({ state: 'ambiguous', error_code: 'AMBIGUOUS_MATCH' });
            // An object with the tag and a name the platform changed (a trim, a re-encoding of the plan's text, an edit by a person) is not taken for missing.
            const w2 = new SandboxAdWriter();
            const second = await queued('Tên bị đổi');
            w2.inject({ level: 'campaign', when: 'after' });
            expect(await run(w2, second.launch.id)).toEqual({ steps: 1, ended: 'unknown' });
            const renamed = [...w2.objects.values()][0] as NonNullable<ReturnType<SandboxAdWriter['objects']['get']>>;
            renamed.name = `${renamed.name} (đã sửa)`;
            await age(second.launch.id, 61);
            expect(await run(w2, second.launch.id)).toEqual({ steps: 1, ended: 'unknowable' });
            expect(await launchNow(second.launch.id)).toMatchObject({ state: 'needs_attention', stop_reason: 'reconcile_unclear' });
            expect(w2.received).toEqual(['campaign']);
            expect((await calls(second.launch.id))[0]).toMatchObject({ state: 'ambiguous', error_code: 'NAME_MISMATCH' });
          });

          it('finds an object by the tail of its name, whatever the platform did to the plan\'s own text in it: no second object is made', async () => {
            const w = new SandboxAdWriter();
            const { launch } = await queued('Tên bị cắt', { name: 'Khuyến mãi cuối tuần với tên khá dài để bị cắt bớt' });
            w.inject({ level: 'campaign', when: 'after' });
            expect(await run(w, launch.id)).toEqual({ steps: 1, ended: 'unknown' });
            // The platform re-encodes and trims the plan's text and keeps the tag and what the object is.
            const campaign = [...w.objects.values()][0] as NonNullable<ReturnType<SandboxAdWriter['objects']['get']>>;
            campaign.name = `${campaign.name.slice(0, 10).normalize('NFD')}… ${launch.tag}`;
            await age(launch.id, 61);
            expect(await run(w, launch.id)).toEqual({ steps: 4, ended: 'paused' });
            expect([...w.objects.values()].filter((o) => o.level === 'campaign')).toHaveLength(1);
            expect((await calls(launch.id))[0]).toMatchObject({ step: 'campaign', state: 'succeeded', calls: 1, external_ref: campaign.id });
          });

          it('stops asking after three calls and tells a person: a step that stays unclear ends as needs attention, with nothing created', async () => {
            const w = new SandboxAdWriter();
            const { launch } = await queued('Không rõ mãi');
            w.inject({ level: 'campaign', when: 'before', times: 3 });
            for (let n = 1; n <= 3; n += 1) {
              expect(await run(w, launch.id), `call ${n}`).toEqual({ steps: 1, ended: 'unknown' });
              await age(launch.id, 61);
            }
            expect(await run(w, launch.id)).toEqual({ steps: 0, ended: 'reconcile_unclear' });
            expect(await launchNow(launch.id)).toMatchObject({ state: 'needs_attention', stop_reason: 'reconcile_unclear' });
            expect(w.received).toEqual(['campaign', 'campaign', 'campaign']);
            expect(w.objects.size).toBe(0);
            expect((await calls(launch.id))[0]).toMatchObject({ state: 'ambiguous', calls: 3 });
          });

          it('tracks an object the platform made while a concurrent run stopped the launch, and leaves a trace of one it cannot record', async () => {
            const { launch } = await queued('Dừng khi đang gọi');
            const writers = [{ provider: 'sandboxwrite_ads', objectives: ['traffic', 'engagement', 'messenger'], currencies: null, media: true }];
            const options = { actor: SYSTEM, orgId };
            const began = await worker.execute<{ action: string; callKey: string; step: string }>('ads.launch.begin', { launchId: launch.id, writers }, options);
            expect(began).toMatchObject({ action: 'call', step: 'campaign' });
            // The switch went off and a run stopped the launch while the call was in flight; the platform made the campaign.
            await inContext('system', (c) => c.query(`UPDATE crove_ads.ad_launch SET state = 'stopped', commit_until = NULL, stop_reason = 'switch_off' WHERE org_id = $1 AND id = $2`, [orgId, launch.id]), true);
            const accepted = { launchId: launch.id, callKey: began.callKey, phase: 'call', result: { kind: 'accepted', externalId: 'sbx-late-1' } };
            expect(await worker.execute('ads.launch.record', accepted, options)).toMatchObject({ recorded: true, state: 'stopped', next: 'stop' });
            expect((await objectsOf(launch.id)).map((o) => [o.slot, o.external_id, o.configured_status])).toEqual([['campaign', 'sbx-late-1', 'paused']]);
            expect(await launchNow(launch.id)).toMatchObject({ state: 'stopped', commit_until: null });
            // A second record for the same call is dropped, with a trace that has the step and the platform's id; and any other result for a launch that is over is stale.
            expect(await worker.execute('ads.launch.record', { ...accepted, result: { kind: 'accepted', externalId: 'sbx-late-2' } }, options)).toEqual({ recorded: false, reason: 'settled' });
            const traces = await row<{ detail: Record<string, unknown> }>(`SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'ads.launch.record' AND detail ->> 'outcome' = 'dropped'`, [orgId]);
            expect(traces.map((t) => t.detail)).toContainEqual(expect.objectContaining({ launchId: launch.id, step: 'campaign', reason: 'settled', externalId: 'sbx-late-2' }));
            expect(await worker.execute('ads.launch.record', { ...accepted, result: { kind: 'missing' } }, options)).toMatchObject({ recorded: false });
          });

          it('serialises jobs that run at the same moment: each object is made once, and the others find the call in flight', async () => {
            const w = new SandboxAdWriter();
            const { launch } = await queued('Chạy song song');
            const results = await Promise.all([run(w, launch.id), run(w, launch.id), run(w, launch.id)]);
            expect(results.reduce((n, r) => n + r.steps, 0)).toBe(4);
            expect(w.received.filter((l) => l === 'campaign')).toHaveLength(1);
            expect([...w.objects.values()].map((o) => o.level).sort()).toEqual(['ad', 'ad_set', 'campaign', 'creative']);
            expect((await calls(launch.id)).map((c) => c.calls)).toEqual([1, 1, 1, 1]);
            expect(await launchNow(launch.id)).toMatchObject({ state: 'launching', step: 'paused' });
          });

          it('ends the run as needs attention when the platform refuses a call, with its code, and never tries that call again', async () => {
            const w = new SandboxAdWriter();
            const { launch } = await queued('Nền tảng từ chối');
            w.inject({ level: 'ad_set', when: 'before', error: new AdPlatformError('bad_request', '100') });
            expect(await run(w, launch.id)).toEqual({ steps: 2, ended: 'rejected' });
            expect(await launchNow(launch.id)).toMatchObject({ state: 'needs_attention', stop_reason: 'platform_refused', step: 'campaign', commit_until: inDays(8) });
            expect((await calls(launch.id))[1]).toMatchObject({ step: 'ad_set', state: 'failed', error_kind: 'bad_request', error_code: '100' });
            expect(await run(w, launch.id)).toEqual({ steps: 0, ended: 'needs_attention' });
            expect(w.received).toEqual(['campaign', 'ad_set']);
          });

          it('ends the run as needs attention before any create when the token is refused or cannot run ads, and says why', async () => {
            const w = new SandboxAdWriter();
            const refusing = (verify: LaunchWriter['verify']) => ({ sandboxwrite_ads: launchWriterOf({ ...launchWriterOf(w), verify }) });
            const first = await queued('Token bị từ chối');
            expect(await run(refusing(async () => { throw new AdPlatformError('token_expired', '190'); }), first.launch.id)).toEqual({ steps: 1, ended: 'token' });
            expect(await launchNow(first.launch.id)).toMatchObject({ state: 'needs_attention', stop_reason: 'token_expired' });
            expect((await calls(first.launch.id))[0]).toMatchObject({ step: 'campaign', state: 'failed', error_kind: 'token_expired', error_code: '190' });
            const second = await queued('Không chạy được quảng cáo');
            expect(await run(refusing(async () => ({ canRunAds: false, scopes: ['ads_read'] })), second.launch.id)).toEqual({ steps: 1, ended: 'cannot_run_ads' });
            expect(await launchNow(second.launch.id)).toMatchObject({ state: 'needs_attention', stop_reason: 'cannot_run_ads' });
            expect(w.received).toEqual([]);
          });

          it('stops a launch with the names listed when the platform does not know a region or an interest, before the ad set is made: nothing spent', async () => {
            const w = new SandboxAdWriter({ unknownTargeting: ['Cà phê muối', 'Đà Lạt (VN)'] });
            const { launch } = await queued('Tên không có', { targeting: { locations: [{ country: 'VN', region: 'Đà Lạt' }], ageMin: 22, ageMax: 45, gender: 'all', interests: ['Cà phê muối', 'Trà sữa'] } });
            expect(await run(w, launch.id)).toEqual({ steps: 2, ended: 'targeting_unknown' });
            expect(w.received).toEqual(['campaign']);
            expect(await launchNow(launch.id)).toMatchObject({ state: 'needs_attention', stop_reason: 'targeting_unknown', step: 'campaign' });
            const listed = await row<{ detail: { unknownTargeting?: string[] } }>(`SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'ads.launch.record' AND detail ->> 'outcome' = 'blocked' ORDER BY id DESC LIMIT 1`, [orgId]);
            expect(listed[0]?.detail.unknownTargeting).toEqual(['Đà Lạt (VN)', 'Cà phê muối']);
          });

          it('fails a plan the writer cannot carry out before any call, with nothing created and the commitment released: no Page, an objective, a currency', async () => {
            const w = new SandboxAdWriter();
            // No Page connection in the plan: every ad needs one.
            const noPage = await queued('Không có trang', {}, false);
            expect(await run(w, noPage.launch.id)).toEqual({ steps: 0, ended: 'page_required' });
            expect(await launchNow(noPage.launch.id)).toMatchObject({ state: 'failed', stop_reason: 'page_required', commit_until: null });
            expect((await launchNow(noPage.launch.id))?.finished_at).toBeInstanceOf(Date);
            // A writer that has no table for the plan's objective, or for the account's currency.
            const narrow = (capabilities: LaunchWriter['capabilities']) => ({ sandboxwrite_ads: launchWriterOf({ ...launchWriterOf(w), capabilities }) });
            const objective = await queued('Mục tiêu chưa hỗ trợ');
            expect(await run(narrow({ objectives: ['engagement'], currencies: null, media: true }), objective.launch.id)).toEqual({ steps: 0, ended: 'objective_unsupported' });
            expect(await launchNow(objective.launch.id)).toMatchObject({ state: 'failed', stop_reason: 'objective_unsupported', commit_until: null });
            const currency = await queued('Tiền tệ chưa hỗ trợ');
            expect(await run(narrow({ objectives: ['traffic'], currencies: ['USD'], media: true }), currency.launch.id)).toEqual({ steps: 0, ended: 'currency_unsupported' });
            expect(await launchNow(currency.launch.id)).toMatchObject({ state: 'failed', stop_reason: 'currency_unsupported' });
            expect(w.received).toEqual([]);
            expect(await calls(noPage.launch.id)).toEqual([]);
          });

          it('sends a launch to a person before any call when the account has no time zone this runtime knows: the flight is never put in a guessed zone, and its commitment is kept', async () => {
            const w = new SandboxAdWriter();
            for (const zone of [null, 'Mars/Phobos']) {
              const { account, launch } = await queued(`Múi giờ ${zone ?? 'trống'}`);
              await row(`UPDATE crove_ads.ad_account SET time_zone = $3 WHERE org_id = $1 AND id = $2`, [orgId, account, zone]);
              expect(await run(w, launch.id), String(zone)).toEqual({ steps: 0, ended: 'zone_unknown' });
              expect(await launchNow(launch.id), String(zone)).toMatchObject({ state: 'needs_attention', stop_reason: 'zone_unknown', commit_until: inDays(8) });
              expect(await calls(launch.id)).toEqual([]);
              // The account is put right again: the reads of the other tests (the spend flags) read every account's zone and refuse one they cannot read.
              await row(`UPDATE crove_ads.ad_account SET time_zone = 'Asia/Ho_Chi_Minh' WHERE org_id = $1 AND id = $2`, [orgId, account]);
            }
            expect(w.received).toEqual([]);
          });

          it('fails a launch whose flight is already over in the account\'s zone before any call: nothing is created and its commitment is released', async () => {
            const w = new SandboxAdWriter();
            const { launch } = await queued('Hết hạn trước khi chạy');
            // The days pass while it waits (the ledger's guard is off for the statement: the plan and its days never change otherwise): the flight ended last month.
            await admin(async (c) => {
              await c.query('ALTER TABLE crove_ads.ad_launch DISABLE TRIGGER launch_guard');
              try {
                await c.query(`UPDATE crove_ads.ad_launch SET start_on = start_on - 30, end_on = end_on - 30, commit_until = commit_until - 30 WHERE org_id = $1 AND id = $2`, [orgId, launch.id]);
              } finally {
                await c.query('ALTER TABLE crove_ads.ad_launch ENABLE ALWAYS TRIGGER launch_guard');
              }
            });
            expect(await run(w, launch.id)).toEqual({ steps: 0, ended: 'flight_over' });
            expect(await launchNow(launch.id)).toMatchObject({ state: 'failed', stop_reason: 'flight_over', commit_until: null });
            expect(w.received).toEqual([]);
            expect(await calls(launch.id)).toEqual([]);
          });

          it('does not arm another create when the owner stops while a reconcile looks: the stop conditions are read again before the call, and the next begin stops the launch', async () => {
            const w = new SandboxAdWriter();
            const { launch } = await queued('Dừng khi đang đối soát');
            w.inject({ level: 'campaign', when: 'before' });
            expect(await run(w, launch.id)).toEqual({ steps: 1, ended: 'unknown' });
            await age(launch.id, 61);
            const writers = [{ provider: 'sandboxwrite_ads', objectives: ['traffic', 'engagement', 'messenger'], currencies: null, media: true }];
            const options = { actor: SYSTEM, orgId };
            const first = await worker.execute<{ action: string; callKey: string; step: string }>('ads.launch.begin', { launchId: launch.id, writers }, options);
            expect(first).toMatchObject({ action: 'reconcile', step: 'campaign' });
            // The owner switches writing off while the lookup runs; the lookup finds nothing, and the job still holds the token it opened.
            expect((await callAs(owner, 'ads/writeDisable', { idempotencyKey: key() })).status).toBe(200);
            const missing = { launchId: launch.id, callKey: first.callKey, phase: 'reconcile', result: { kind: 'missing' } };
            expect(await worker.execute('ads.launch.record', missing, options)).toMatchObject({ recorded: true, next: 'stop' });
            expect((await calls(launch.id))[0]).toMatchObject({ step: 'campaign', state: 'ambiguous', calls: 1 });
            expect(w.received).toEqual(['campaign']);
            expect(await run(w, launch.id)).toEqual({ steps: 0, ended: 'switch_off' });
            expect(w.received).toEqual(['campaign']);
          });

          it('cancels a queued launch before its first call when a cap was lowered since the approval, and releases its commitment', async () => {
            const w = new SandboxAdWriter();
            const { account, launch } = await queued('Hạ hạn mức trước khi chạy', { dailyBudget: '150000' });
            expect((await callAs(owner, 'ads/lowerCap', { idempotencyKey: key(), scope: 'org', period: 'daily', amount: '100000' })).status).toBe(200);
            expect(await run(w, launch.id)).toEqual({ steps: 0, ended: 'cap_lowered' });
            expect(await launchNow(launch.id)).toMatchObject({ state: 'cancelled', stop_reason: 'cap_lowered', commit_until: null });
            expect(w.received).toEqual([]);
            expect(await calls(launch.id)).toEqual([]);
            // The commitment is released: the account's next plan of the same days is judged against the lowered cap alone.
            const next = await saved(owner, account, plan({ name: 'Sau khi hủy', dailyBudget: '90000' }));
            expect((await submit(owner, next.id)).status).toBe(200);
          });

          it('stops a launch that is half way when writing is switched off or launches are blocked: the stop is a person\'s, so its commitment stays to today, and nothing is created after', async () => {
            const w = new SandboxAdWriter();
            const first = await queued('Tắt giữa chừng');
            w.inject({ level: 'ad_set', when: 'after' });
            expect(await run(w, first.launch.id)).toEqual({ steps: 2, ended: 'unknown' });
            expect(await launchNow(first.launch.id)).toMatchObject({ state: 'launching' });
            expect((await callAs(owner, 'ads/writeDisable', { idempotencyKey: key() })).status).toBe(200);
            // The switch-off stopped it, as the owner's stop: the commitment is shortened to today and never cleared (what ran or is in flight still counts), and the job
            // that comes after finds it done and creates nothing.
            expect(await launchNow(first.launch.id)).toMatchObject({ state: 'stopped', stop_reason: 'switch_off', commit_until: inDays(0) });
            await age(first.launch.id, 61);
            expect(await run(w, first.launch.id)).toEqual({ steps: 0, ended: 'final' });
            expect(w.received).toEqual(['campaign', 'ad_set']);
            // The same with the kill switch.
            const second = await queued('Chặn giữa chừng');
            w.inject({ level: 'ad_set', when: 'after' });
            expect(await run(w, second.launch.id)).toEqual({ steps: 2, ended: 'unknown' });
            expect((await callAs(adminAccount, 'ads/pauseAll', { idempotencyKey: key() })).status).toBe(200);
            await age(second.launch.id, 61);
            expect(await run(w, second.launch.id)).toEqual({ steps: 0, ended: 'final' });
            expect(await launchNow(second.launch.id)).toMatchObject({ state: 'stopped', stop_reason: 'launches_blocked', commit_until: inDays(0) });
          });

          it('stops a launch whose connection closed while it ran, as the system: nothing ran, so the commitment is released, and the pause of what it made is queued', async () => {
            const w = new SandboxAdWriter();
            const { account, launch } = await queued('Kết nối đóng giữa chừng');
            w.inject({ level: 'ad_set', when: 'after' });
            expect(await run(w, launch.id)).toEqual({ steps: 2, ended: 'unknown' });
            // The write connection is closed behind the launch's back (a member who left): the next begin finds the condition and stops it.
            await row(`UPDATE crove_kernel.channel_connection SET status = 'revoked' WHERE org_id = $1 AND id = (SELECT write_connection_id FROM crove_ads.ad_account WHERE org_id = $1 AND id = $2)`, [orgId, account]);
            await age(launch.id, 61);
            expect(await run(w, launch.id)).toEqual({ steps: 0, ended: 'connection_closed' });
            expect(await launchNow(launch.id)).toMatchObject({ state: 'stopped', stop_reason: 'connection_closed', commit_until: null });
            const events = await row<{ payload: Record<string, unknown> }>(`SELECT payload FROM crove_kernel.outbox_event WHERE org_id = $1 AND type = 'ads.pause.queued' AND payload ->> 'launchId' = $2`, [orgId, launch.id]);
            expect(events.map((e) => Object.keys(e.payload).sort())).toEqual([['adAccountId', 'launchId']]);
          });

          it('leaves a launch queued, untouched, when this worker has no writer for its connection\'s provider', async () => {
            const { launch } = await queued('Không có writer');
            expect(await run({}, launch.id)).toEqual({ steps: 0, ended: 'no_writer' });
            expect(await run({ metawrite_ads: launchWriterOf(new SandboxAdWriter()) }, launch.id)).toEqual({ steps: 0, ended: 'no_writer' });
            expect(await launchNow(launch.id)).toMatchObject({ state: 'queued', step: null, commit_until: inDays(8) });
            expect(await calls(launch.id)).toEqual([]);
          });

          it('begins nothing when the worker cannot open a token: no ledger row is left for a call that cannot be made', async () => {
            const { launch } = await queued('Không có khóa');
            const none = { ...vault, id: 'none' } as unknown as CredentialVault;
            expect(await runAdsLaunch({ runtime: worker, broker: none, writers: adLaunchWriters({ sandbox: new SandboxAdWriter() }) }, { orgId, launchId: launch.id })).toEqual({ steps: 0, ended: 'no_broker' });
            expect(await calls(launch.id)).toEqual([]);
            expect((await launchNow(launch.id))?.state).toBe('queued');
          });

          it('treats an answer with more pages than the first as unknowable when it reconciles: nothing is created, and the launch is looked at again', async () => {
            const w = new SandboxAdWriter();
            const { launch } = await queued('Câu trả lời nhiều trang');
            w.inject({ level: 'ad_set', when: 'after' });
            expect(await run(w, launch.id)).toEqual({ steps: 2, ended: 'unknown' });
            await age(launch.id, 61);
            // The list of ad sets by the tag says there is more than one page: not the whole answer, so not "missing" and not "found".
            w.inject({ level: 'ad_set', when: 'find' });
            expect(await run(w, launch.id)).toEqual({ steps: 1, ended: 'unknowable' });
            expect(w.received).toEqual(['campaign', 'ad_set']);
            expect((await calls(launch.id))[1]).toMatchObject({ step: 'ad_set', state: 'ambiguous', calls: 1, error_code: 'PAGED_ANSWER' });
            expect(await launchNow(launch.id)).toMatchObject({ state: 'launching' });
            // The next look reads the list in full, finds the ad set and goes on: no second ad set was ever made.
            await age(launch.id, 61);
            expect(await run(w, launch.id)).toEqual({ steps: 3, ended: 'paused' });
            expect([...w.objects.values()].filter((o) => o.level === 'ad_set')).toHaveLength(1);
          });

          describe('stopping a launch and pausing what it made (W2-4a)', () => {
            const startedNow = async (name: string, w: SandboxAdWriter, over: Record<string, unknown> = {}) => {
              const made = await queued(name, over);
              expect(await run(w, made.launch.id)).toMatchObject({ ended: 'paused' });
              return made;
            };
            const pauseRun = (w: SandboxAdWriter, launchId: string) => runAdsPause({ runtime: worker, broker: vault, pausers: adPausers({ sandbox: w }) }, { orgId, launchId });
            const windDown = async (id: string) =>
              (await row<{ wound_down_at: Date | null; wind_down_tries: number; wind_down_next_at: Date | null; wind_down_code: string | null }>(`SELECT wound_down_at, wind_down_tries, wind_down_next_at, wind_down_code FROM crove_ads.ad_launch WHERE org_id = $1 AND id = $2`, [orgId, id]))[0];
            const pauseCalls = (id: string) => row<{ key: string; step: string; state: string; error_kind: string | null; error_code: string | null }>(`SELECT key, step, state, error_kind, error_code FROM crove_kernel.external_call WHERE org_id = $1 AND key LIKE $2 ORDER BY key`, [orgId, `ads.pause:${id}:%`]);
            const stopAs = (who: Account, launchId: string) => callAs(who, 'ads/stopLaunch', { launchId, idempotencyKey: key() });
            // The ledger's guard is on for every role, so a test that puts a clock or a count back does it with the guard off for the statement, as the ledger's own tests do.
            const edit = (statement: string, params: unknown[]) =>
              admin(async (c) => {
                await c.query('ALTER TABLE crove_ads.ad_launch DISABLE TRIGGER launch_guard');
                try {
                  await c.query(statement, params);
                } finally {
                  await c.query('ALTER TABLE crove_ads.ad_launch ENABLE ALWAYS TRIGGER launch_guard');
                }
              });
            const dueNow = (id: string) => edit(`UPDATE crove_ads.ad_launch SET wind_down_next_at = now() - interval '1 second' WHERE org_id = $1 AND id = $2`, [orgId, id]);

            it('lets an owner or an admin stop a launch that has started, keeps its commitment to today, and the pause job pauses what it made, once, by the record and the tag', async () => {
              const w = new SandboxAdWriter();
              const { launch, draft } = await startedNow('Dừng và tạm dừng', w);
              expect(w.objects.size).toBeGreaterThanOrEqual(4);
              for (const who of [member, viewer]) expect((await stopAs(who, launch.id)).status, who.email).toBe(403);
              expect(await launchNow(launch.id)).toMatchObject({ state: 'launching', step: 'paused', commit_until: inDays(8) });
              const stopped = await stopAs(adminAccount, launch.id);
              expect(stopped).toMatchObject({ status: 200, body: { launchId: launch.id, state: 'stopped', commitUntil: inDays(0) } });
              expect(await launchNow(launch.id)).toMatchObject({ state: 'stopped', stop_reason: 'stopped', commit_until: inDays(0) });
              expect((await stopAs(owner, launch.id)).status).toBe(409);
              // The wind-down is open and the builder says the ads are being paused.
              expect(await windDown(launch.id)).toMatchObject({ wound_down_at: null, wind_down_tries: 0, wind_down_code: null });
              const pending = await callAs(owner, 'ads/campaignDraft', { draftId: draft.id });
              expect(pending.body).toMatchObject({ launch: { state: 'stopped', windDown: { state: 'pending', code: null } } });
              // The job: claims it, pauses the campaign, then the ad set, then the ads, and records.
              expect(await pauseRun(w, launch.id)).toEqual({ ran: true, ended: 'done' });
              const levels = w.statusCalls.map((c) => c.level);
              expect(levels.slice(0, 2)).toEqual(['campaign', 'ad_set']);
              expect(levels.slice(2).every((l) => l === 'ad')).toBe(true);
              expect(levels).toHaveLength(2 + [...w.objects.values()].filter((o) => o.level === 'ad').length);
              expect(w.statusCalls.every((c) => c.status === 'paused')).toBe(true);
              expect([...w.objects.values()].every((o) => o.status === 'paused')).toBe(true);
              expect(await windDown(launch.id)).toMatchObject({ wind_down_tries: 1, wind_down_next_at: null, wind_down_code: null });
              expect((await windDown(launch.id))?.wound_down_at).toBeInstanceOf(Date);
              expect(await pauseCalls(launch.id)).toMatchObject([{ key: `ads.pause:${launch.id}:1`, step: 'pause', state: 'succeeded' }]);
              expect((await callAs(owner, 'ads/campaignDraft', { draftId: draft.id })).body).toMatchObject({ launch: { windDown: { state: 'done', code: null } } });
              // Once: a second run finds it done and calls nothing; so does a repeated event.
              const calls1 = w.statusCalls.length;
              expect(await pauseRun(w, launch.id)).toEqual({ ran: false, ended: 'wound_down' });
              expect(w.statusCalls).toHaveLength(calls1);
              // The audit says how many were paused, and the token is in no audit row or ledger row.
              const audited = await row<{ detail: Record<string, unknown> }>(`SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'ads.pause.record' AND detail ->> 'launchId' = $2`, [orgId, launch.id]);
              expect(audited).toHaveLength(1);
              expect(audited[0]?.detail).toMatchObject({ outcome: 'done', via: 'connection', tries: 1, paused: calls1, failed: [], notTried: 0, listed: { campaign: true, ad_set: true, ad: true } });
              const leaks = await row<{ n: string }>(`SELECT ((SELECT count(*) FROM crove_kernel.audit_event WHERE org_id = $1 AND detail::text LIKE '%sbxw_%') + (SELECT count(*) FROM crove_kernel.external_call WHERE org_id = $1 AND (key || coalesce(error_code, '')) LIKE '%sbxw_%'))::text AS n`, [orgId]);
              expect(leaks[0]?.n).toBe('0');
            });

            it('is the system\'s alone: no owner, admin, member or agent runs begin or record of the pause', async () => {
              const w = new SandboxAdWriter();
              const { launch } = await startedNow('Chỉ hệ thống tạm dừng', w);
              await stopAs(owner, launch.id);
              const begin = { launchId: launch.id, via: 'connection' };
              const record = { launchId: launch.id, callKey: `ads.pause:${launch.id}:1`, via: 'connection', result: { kind: 'blocked', code: 'x' } };
              for (const who of [asOwner(), { type: 'user' as const, userId: adminAccount.userId, aal: 'aal1' as const, sessionId: randomUUID() }, { type: 'user' as const, userId: member.userId, aal: 'aal1' as const, sessionId: randomUUID() }]) {
                await expect(api.execute('ads.pause.begin', begin, { actor: who, orgId })).rejects.toMatchObject({ status: 403 });
                await expect(api.execute('ads.pause.record', record, { actor: who, orgId })).rejects.toMatchObject({ status: 403 });
              }
              expect(await windDown(launch.id)).toMatchObject({ wind_down_tries: 0 });
            });

            it('pauses an object whose create was in flight when the launch was stopped, found by the launch\'s tag, and records it', async () => {
              const w = new SandboxAdWriter();
              const { launch } = await queued('Tạo dở lúc dừng');
              // The ad set is made at the platform and the answer is lost: the launch has the campaign recorded and an ad set it does not know.
              w.inject({ level: 'ad_set', when: 'after' });
              expect(await run(w, launch.id)).toEqual({ steps: 2, ended: 'unknown' });
              expect(await objectsOf(launch.id)).toHaveLength(1);
              expect((await stopAs(owner, launch.id)).status).toBe(200);
              expect(await pauseRun(w, launch.id)).toEqual({ ran: true, ended: 'done' });
              const adSet = [...w.objects.values()].find((o) => o.level === 'ad_set');
              expect(w.statusCalls.map((c) => c.id)).toContain(adSet?.id);
              // It is recorded now, as the launch's ad set, with the name the platform has.
              const objects = await objectsOf(launch.id);
              expect(objects.map((o) => o.slot)).toEqual(['campaign', 'ad_set']);
              expect(objects.find((o) => o.slot === 'ad_set')).toMatchObject({ external_id: adSet?.id, configured_status: 'paused' });
              expect((await windDown(launch.id))?.wound_down_at).toBeInstanceOf(Date);
              const audited = await row<{ detail: Record<string, unknown> }>(`SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'ads.pause.record' AND detail ->> 'launchId' = $2`, [orgId, launch.id]);
              expect(audited[0]?.detail).toMatchObject({ found: 2, recordedObjects: 1, unrecorded: [] });
            });

            it('holds the wind-down while a create of the launch may still land, and finishes once it has settled or is old enough to be lost', async () => {
              const w = new SandboxAdWriter();
              const { launch } = await queued('Chờ tạo xong');
              // The worker dies after the platform made the campaign and before the record: a begun call, young.
              const dying = new Proxy(worker, {
                get: (target, prop) => {
                  if (prop === 'execute') {
                    return async (name: string, input: never, options: never) => {
                      if (name === 'ads.launch.record') throw new Error('process killed');
                      return target.execute(name, input, options);
                    };
                  }
                  const member = Reflect.get(target, prop, target) as unknown;
                  return typeof member === 'function' ? (member as (...args: unknown[]) => unknown).bind(target) : member;
                },
              });
              await expect(run(w, launch.id, dying)).rejects.toThrow('process killed');
              expect((await stopAs(owner, launch.id)).status).toBe(200);
              // The pause finds the campaign by the tag and pauses it, but a create may still land: not wound down, due again in a few minutes.
              expect(await pauseRun(w, launch.id)).toEqual({ ran: true, ended: 'pending' });
              expect(w.statusCalls.map((c) => c.level)).toEqual(['campaign']);
              const held = await windDown(launch.id);
              expect(held).toMatchObject({ wound_down_at: null, wind_down_tries: 1, wind_down_code: null });
              expect(Date.parse(String(held?.wind_down_next_at))).toBeGreaterThan(Date.now() + 55_000);
              expect((await objectsOf(launch.id)).map((o) => o.slot)).toEqual(['campaign']);
              expect(await pauseCalls(launch.id)).toMatchObject([{ state: 'failed', error_code: 'CREATE_IN_FLIGHT' }]);
              // Not due yet: another run finds nothing to do; due, and the begun call old enough to be lost: it finishes.
              expect(await pauseRun(w, launch.id)).toEqual({ ran: false, ended: 'in_flight' });
              await age(launch.id, 301);
              await dueNow(launch.id);
              expect(await pauseRun(w, launch.id)).toEqual({ ran: true, ended: 'done' });
              expect((await windDown(launch.id))?.wound_down_at).toBeInstanceOf(Date);
              expect(await windDown(launch.id)).toMatchObject({ wind_down_tries: 2 });
            });

            it('gives up and says why: a refused token at once, the tenth run, the seventh day; and nothing is paused with a launch that made nothing', async () => {
              // A refused token cannot pause anything.
              const w1 = new SandboxAdWriter();
              const refusedToken = await startedNow('Token bị từ chối', w1);
              await stopAs(owner, refusedToken.launch.id);
              w1.inject({ level: 'campaign', when: 'status', error: new AdPlatformError('token_expired', 'TOKEN') });
              expect(await pauseRun(w1, refusedToken.launch.id)).toEqual({ ran: true, ended: 'gave_up' });
              expect(await windDown(refusedToken.launch.id)).toMatchObject({ wound_down_at: null, wind_down_next_at: null, wind_down_code: 'token_refused', wind_down_tries: 1 });
              expect((await callAs(owner, 'ads/campaignDraft', { draftId: refusedToken.draft.id })).body).toMatchObject({ launch: { windDown: { state: 'gave_up', code: 'token_refused' } } });
              expect(await pauseCalls(refusedToken.launch.id)).toMatchObject([{ state: 'failed', error_kind: 'token_expired' }]);
              // Given up: a later run does nothing.
              expect(await pauseRun(w1, refusedToken.launch.id)).toEqual({ ran: false, ended: 'gave_up' });
              // The tenth run that does not finish.
              const w2 = new SandboxAdWriter();
              const tenth = await startedNow('Lần thứ mười', w2);
              await stopAs(owner, tenth.launch.id);
              await edit(`UPDATE crove_ads.ad_launch SET wind_down_tries = 9 WHERE org_id = $1 AND id = $2`, [orgId, tenth.launch.id]);
              w2.inject({ level: 'ad', when: 'status', error: new AdPlatformError('transient', 'NETWORK') });
              expect(await pauseRun(w2, tenth.launch.id)).toEqual({ ran: true, ended: 'gave_up' });
              expect(await windDown(tenth.launch.id)).toMatchObject({ wind_down_tries: 10, wind_down_code: 'attempts', wound_down_at: null });
              // The seventh day: nothing is called.
              const w3 = new SandboxAdWriter();
              const old = await startedNow('Quá bảy ngày', w3);
              await stopAs(owner, old.launch.id);
              await edit(`UPDATE crove_ads.ad_launch SET finished_at = now() - interval '8 days' WHERE org_id = $1 AND id = $2`, [orgId, old.launch.id]);
              expect(await pauseRun(w3, old.launch.id)).toEqual({ ran: false, ended: 'gave_up' });
              expect(w3.statusCalls).toEqual([]);
              expect(await windDown(old.launch.id)).toMatchObject({ wind_down_code: 'age', wind_down_tries: 0 });
              // A launch that made nothing and ran nothing is wound down at once, with no call to the platform.
              const w4 = new SandboxAdWriter();
              const blank = await queued('Chưa tạo gì');
              await row(`UPDATE crove_ads.ad_account SET time_zone = NULL WHERE org_id = $1 AND id = $2`, [orgId, blank.account]);
              expect(await run(w4, blank.launch.id)).toEqual({ steps: 0, ended: 'zone_unknown' });
              await row(`UPDATE crove_ads.ad_account SET time_zone = 'Asia/Ho_Chi_Minh' WHERE org_id = $1 AND id = $2`, [orgId, blank.account]);
              expect((await stopAs(owner, blank.launch.id)).status).toBe(200);
              expect(await pauseRun(w4, blank.launch.id)).toEqual({ ran: false, ended: 'nothing_to_pause' });
              expect((await windDown(blank.launch.id))?.wound_down_at).toBeInstanceOf(Date);
              expect(w4.received).toEqual([]);
              expect(w4.statusCalls).toEqual([]);
            });

            it('on a switch-off pauses with the sealed copy of the closed connection\'s token before it revokes the permission, and waits for the pause when it fails', async () => {
              const w = new SandboxAdWriter();
              const { launch, account } = await startedNow('Tắt công tắc rồi gỡ quyền', w);
              expect((await callAs(owner, 'ads/writeDisable', { idempotencyKey: key() })).status).toBe(200);
              expect(await launchNow(launch.id)).toMatchObject({ state: 'stopped', stop_reason: 'switch_off', commit_until: inDays(0) });
              // The write connection closed in the same transaction: its token is gone from the connection, and a copy is held for the revoke.
              const obligation = async () => (await row<{ state: string; attempts: number; last_error_kind: string | null; last_error_code: string | null }>(`SELECT state, attempts, last_error_kind, last_error_code FROM crove_ads.ad_token_revoke WHERE org_id = $1 AND ad_account_id = $2 AND kind = 'write' ORDER BY created_at DESC LIMIT 1`, [orgId, account]))[0];
              expect(await obligation()).toMatchObject({ state: 'pending', attempts: 0 });
              // The pause job has no token of its own any more: it leaves the launch to the revoke sweep, counts no try, and calls nothing.
              expect(await pauseRun(w, launch.id)).toEqual({ ran: false, ended: 'revoke_path' });
              expect(w.statusCalls).toEqual([]);
              expect(await windDown(launch.id)).toMatchObject({ wind_down_tries: 0 });
              // The sweep opens the copy, pauses what the launch made with it first, and does not revoke while the pause is not finished: one ad could not be paused.
              w.inject({ level: 'ad', when: 'status', error: new AdPlatformError('transient', 'NETWORK') });
              const sweep = () => runAdsRevoke({ runtime: worker, workerDb, broker: vault, revokers: { sandboxwrite_ads: revokerOf(w) } });
              expect(await sweep()).toMatchObject({ tried: 1, done: 0 });
              expect(w.statusCalls.map((c) => c.level).slice(0, 2)).toEqual(['campaign', 'ad_set']);
              expect(await obligation()).toMatchObject({ state: 'pending', attempts: 1, last_error_kind: 'transient', last_error_code: 'PAUSE_PENDING' });
              expect(await windDown(launch.id)).toMatchObject({ wound_down_at: null, wind_down_tries: 1 });
              // Due again: the pause finishes with the same copy, the launch is wound down, and the permission is removed after it.
              await admin((c) => c.query(`UPDATE crove_ads.ad_token_revoke SET next_attempt_at = now() WHERE state = 'pending'`));
              await dueNow(launch.id);
              expect(await sweep()).toMatchObject({ tried: expect.any(Number), done: expect.any(Number) });
              expect([...w.objects.values()].every((o) => o.status === 'paused')).toBe(true);
              expect((await windDown(launch.id))?.wound_down_at).toBeInstanceOf(Date);
              expect(await obligation()).toMatchObject({ state: 'done' });
              const how = await row<{ how_done: string | null }>(`SELECT how_done FROM crove_ads.ad_token_revoke WHERE org_id = $1 AND ad_account_id = $2 AND kind = 'write' ORDER BY created_at DESC LIMIT 1`, [orgId, account]);
              expect(how[0]?.how_done).toBe('sandbox');
            });

            it('refuses to delete an account\'s history while a launch is not wound down, and says what the platform\'s own deletion request leaves behind', async () => {
              const w = new SandboxAdWriter();
              const { launch, account } = await startedNow('Xóa lịch sử khi đang chạy', w);
              const refusal = await callAs(owner, 'ads/deleteHistory', { adAccountId: account, idempotencyKey: key() });
              expect(refusal).toMatchObject({ status: 409, body: { code: 'ADS_LAUNCH_NOT_WOUND_DOWN' } });
              expect((await stopAs(owner, launch.id)).status).toBe(200);
              expect((await callAs(owner, 'ads/deleteHistory', { adAccountId: account, idempotencyKey: key() })).status).toBe(409);
              expect(await pauseRun(w, launch.id)).toEqual({ ran: true, ended: 'done' });
              expect((await callAs(owner, 'ads/deleteHistory', { adAccountId: account, idempotencyKey: key() })).status).toBe(200);
              // The platform's request is not refused: the account and its launches go, and the audit row lists what was left running, by its platform ids.
              const other = new SandboxAdWriter();
              const left = await startedNow('Nền tảng yêu cầu xóa', other);
              const ids = [...other.objects.values()].filter((o) => ['campaign', 'ad_set', 'ad'].includes(o.level)).map((o) => o.id).sort();
              await worker.execute('ads.account.erase', { adAccountId: left.account }, { actor: SYSTEM, orgId });
              const audited = await row<{ detail: { launchesNotWoundDown?: number; objects?: Array<{ level: string; id: string }> } }>(`SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'ads.account.erase' AND detail ->> 'adAccountId' = $2`, [orgId, left.account]);
              expect(audited[0]?.detail.launchesNotWoundDown).toBe(1);
              expect((audited[0]?.detail.objects ?? []).map((o) => o.id).sort()).toEqual(ids);
              expect(await launchNow(left.launch.id)).toBeUndefined();
            });
          });
        });
      });
    });

    // W0b: the write connection of an ad account (ADR-0043 points 3 and 4): its own provider, its own sealed token, attached to the account the
    // read connection linked, the owner's, only while the org's switch is on, and closed (its token dropped) when writing is switched off.
    describe('the write connection (W0b)', () => {
      const attached = async (adAccountId: string) => (await row<{ id: string | null }>(`SELECT write_connection_id AS id FROM crove_ads.ad_account WHERE org_id = $1 AND id = $2`, [orgId, adAccountId]))[0]?.id ?? null;
      const status = async (connectionId: string) => (await row<{ status: string }>(`SELECT status FROM crove_kernel.channel_connection WHERE org_id = $1 AND id = $2`, [orgId, connectionId]))[0]?.status;
      const sealed = async (connectionId: string) => (await row<{ n: string }>(`SELECT count(*)::text AS n FROM crove_kernel.credential WHERE org_id = $1 AND connection_id = $2`, [orgId, connectionId]))[0]?.n;
      const connectWrite = (who: Account, adAccountId: string) => callAs(who, 'ads/connectSandboxWrite', { adAccountId, idempotencyKey: key() });
      // A sandbox account connected for reading, the switch on, and its write connection made by the owner.
      const withWrite = async (name: string) => {
        const made = await connect(name);
        const done = await connectWrite(owner, made.adAccountId);
        expect(done.status, JSON.stringify(done.body)).toBe(200);
        return { ...made, writeConnectionId: done.body.connectionId as string };
      };
      // An active write connection of an account that no account refers to: what the sign-in dialog leaves between making a connection and
      // attaching it (a crash, a deploy, or a refused attaching whose close failed), with its sealed token.
      const unattachedWrite = async (adAccountId: string, provider: 'sandboxwrite_ads' = 'sandboxwrite_ads') => {
        const external = (await row<{ e: string }>(`SELECT external_account_id AS e FROM crove_ads.ad_account WHERE org_id = $1 AND id = $2`, [orgId, adAccountId]))[0]?.e as string;
        const login = sandboxWriteLogin({ externalAccountId: external, currency: 'VND' });
        expect(login.provider).toBe(provider);
        const token = vault.seal(login.secret, { orgId, provider: login.provider, externalAccountId: login.externalAccountId });
        const made = await api.execute<{ connectionId: string }>(
          'kernel.channel.connect',
          { provider: login.provider, externalAccountId: login.externalAccountId, displayName: 'Chưa gắn', scopes: [...login.scopes], expiresAt: null, credential: { keyId: token.keyId, envelope: token.envelope.toString('base64') } },
          { actor: asOwner(), orgId },
        );
        return made.connectionId;
      };
      const META_SECRET = 'meta-app-secret';
      // Meta's data deletion request for a person, accepted as the API does and run as the worker's relay.
      const requestDeletion = async (userId: string) => {
        const encoded = Buffer.from(JSON.stringify({ algorithm: 'HMAC-SHA256', issued_at: Math.floor(Date.now() / 1000), user_id: userId })).toString('base64url');
        const signedRequest = `${createHmac('sha256', META_SECRET).update(encoded).digest('base64url')}.${encoded}`;
        const accepted = await acceptAdsDeletion(api, META_SECRET, new URLSearchParams({ signed_request: signedRequest }).toString());
        expect(accepted.status).toBe(200);
        expect(await runAdsDeletions({ runtime: worker, workerDb })).toBeGreaterThanOrEqual(1);
        return (accepted as { code: string }).code;
      };

      it('connects the sandbox’s write connection for the owner alone, while the switch is on, with its own sealed token', async () => {
        await closed();
        const made = await connect('Kết nối ghi');
        // The switch off: nothing is made, and no connection is left behind.
        expect(await connectWrite(owner, made.adAccountId)).toMatchObject({ status: 409, body: { code: 'ADS_WRITE_OFF' } });
        expect((await row<{ n: string }>(`SELECT count(*)::text AS n FROM crove_kernel.channel_connection WHERE org_id = $1 AND provider = 'sandboxwrite_ads' AND status <> 'revoked'`, [orgId]))[0]?.n).toBe('0');
        await open();
        for (const who of [adminAccount, member, viewer]) expect((await connectWrite(who, made.adAccountId)).status, who.email).toBe(403);
        const done = await connectWrite(owner, made.adAccountId);
        expect(done).toMatchObject({ status: 200, body: { adAccountId: made.adAccountId } });
        const writeId = done.body.connectionId as string;
        // Attached to the account the read connection linked, a connection of its own with its own sealed token and the permission that
        // can change campaigns, and the read connection untouched.
        expect(await attached(made.adAccountId)).toBe(writeId);
        expect(await view(owner, made.adAccountId)).toMatchObject({ canRunAds: true, writeConnectionStatus: 'active', connectionStatus: 'active', provider: 'sandbox_ads', extraScopes: [] });
        const connection = (await row<{ provider: string; scopes: string[]; external_account_id: string }>(`SELECT provider, scopes, external_account_id FROM crove_kernel.channel_connection WHERE org_id = $1 AND id = $2`, [orgId, writeId]))[0];
        expect(connection).toMatchObject({ provider: 'sandboxwrite_ads', scopes: expect.arrayContaining(['ads_management']) });
        expect(connection?.external_account_id).toBe((await row<{ e: string }>(`SELECT external_account_id AS e FROM crove_ads.ad_account WHERE org_id = $1 AND id = $2`, [orgId, made.adAccountId]))[0]?.e);
        expect(await sealed(writeId)).toBe('1');
        expect(await sealed(made.connectionId)).toBe('1');
        // It is never an account of its own: the list holds the one account, and the read sync still works on the read connection.
        const listed = (await ok('ads/accounts', owner, undefined)) as AdAccountView[];
        expect(listed.filter((a) => a.name === 'Kết nối ghi')).toHaveLength(1);
        await sync(made.connectionId);
        // Connecting again is the same connection, still attached.
        expect((await connectWrite(owner, made.adAccountId)).body.connectionId).toBe(writeId);
        // No token is in an answer, an audit row or an event.
        const leaks = await row<{ n: string }>(`SELECT (SELECT count(*) FROM crove_kernel.audit_event WHERE org_id = $1 AND detail::text LIKE '%sbxw_%') + (SELECT count(*) FROM crove_kernel.outbox_event WHERE org_id = $1 AND payload::text LIKE '%sbxw_%') AS n`, [orgId]);
        expect(leaks[0]?.n).toBe('0');
      });

      it('never lets the write connection through the account link, and needs the read link first', async () => {
        await open();
        const made = await withWrite('Không qua liên kết');
        await expect(api.execute('ads.account.link', { connectionId: made.writeConnectionId }, { actor: asOwner(), orgId })).rejects.toMatchObject({ status: 404, code: 'ADS_CONNECTION_NOT_FOUND' });
        // A write connection of a platform account the read connection never linked is refused and attaches to nothing.
        const orphan = randomUUID();
        await row(`INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, 'sandboxwrite_ads', 'sbxads-unlinked', 'Chưa liên kết', $3)`, [orgId, orphan, owner.userId]);
        await expect(api.execute('ads.account.link_write', { connectionId: orphan }, { actor: asOwner(), orgId })).rejects.toMatchObject({ status: 409, code: 'ADS_WRITE_NEEDS_READ' });
        // Nor with the switch off, and not for an admin.
        await expect(api.execute('ads.account.link_write', { connectionId: made.writeConnectionId }, { actor: { type: 'user', userId: adminAccount.userId, aal: 'aal1', sessionId: randomUUID() }, orgId })).rejects.toMatchObject({ status: 403 });
        await closed();
        await expect(api.execute('ads.account.link_write', { connectionId: made.writeConnectionId }, { actor: asOwner(), orgId })).rejects.toMatchObject({ status: 409, code: 'ADS_WRITE_OFF' });
      });

      it('closes every write connection and drops its sealed token when writing is switched off, and only the write ones', async () => {
        await open();
        const first = await withWrite('Tắt cả tổ chức một');
        const second = await withWrite('Tắt cả tổ chức hai');
        const reading = await connect('Chỉ đọc');
        expect(await sealed(first.writeConnectionId)).toBe('1');
        expect((await callAs(adminAccount, 'ads/writeDisable', { idempotencyKey: key() })).status).toBe(403);
        const off = await callAs(owner, 'ads/writeDisable', { idempotencyKey: key() });
        expect(off.status, JSON.stringify(off.body)).toBe(200);
        expect(off.body.connectionsClosed).toBeGreaterThanOrEqual(2);
        for (const made of [first, second]) {
          expect(await status(made.writeConnectionId)).toBe('revoked');
          expect(await sealed(made.writeConnectionId)).toBe('0');
          expect(await view(owner, made.adAccountId)).toMatchObject({ canRunAds: false, writeConnectionStatus: 'revoked', connectionStatus: 'active', writeEnabled: false });
        }
        // The read connections and their tokens stay; an account that never had a write connection is untouched.
        expect(await sealed(first.connectionId)).toBe('1');
        expect(await view(owner, reading.adAccountId)).toMatchObject({ canRunAds: false, writeConnectionStatus: null, connectionStatus: 'active' });
        // The closing is audited once per connection, with no token in it.
        const audit = await row<{ n: string }>(`SELECT count(*)::text AS n FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'kernel.channel.disconnect' AND outcome = 'ok' AND target_id = $2`, [orgId, first.writeConnectionId]);
        expect(Number(audit[0]?.n)).toBeGreaterThanOrEqual(1);
        // A new one replaces the closed one once the switch is on again (the owner connects, the closed connection stays as the record).
        await open();
        const again = await connectWrite(owner, first.adAccountId);
        expect(again.status).toBe(200);
        expect(again.body.connectionId).not.toBe(first.writeConnectionId);
        expect(await attached(first.adAccountId)).toBe(again.body.connectionId);
        expect(await view(owner, first.adAccountId)).toMatchObject({ canRunAds: true, writeConnectionStatus: 'active' });
      });

      it('closes only that account’s write connection when its flag is withdrawn', async () => {
        await open();
        const first = await withWrite('Một tài khoản một');
        const second = await withWrite('Một tài khoản hai');
        const off = await callAs(owner, 'ads/disableAccountWrite', { adAccountId: first.adAccountId, idempotencyKey: key() });
        expect(off).toMatchObject({ status: 200, body: { connectionsClosed: 1 } });
        expect(await status(first.writeConnectionId)).toBe('revoked');
        expect(await sealed(first.writeConnectionId)).toBe('0');
        expect(await status(second.writeConnectionId)).toBe('active');
        expect(await sealed(second.writeConnectionId)).toBe('1');
        expect(await view(owner, second.adAccountId)).toMatchObject({ canRunAds: true });
      });

      it('disconnects an account for an owner or an admin: both connections closed, both tokens dropped, the row and its figures stay', async () => {
        await open();
        const made = await withWrite('Ngắt cả hai');
        expect((await callAs(member, 'ads/disconnectAccount', { adAccountId: made.adAccountId, idempotencyKey: key() })).status).toBe(403);
        const done = await callAs(adminAccount, 'ads/disconnectAccount', { adAccountId: made.adAccountId, idempotencyKey: key() });
        expect(done).toMatchObject({ status: 200, body: { adAccountId: made.adAccountId, closed: 2 } });
        for (const id of [made.connectionId, made.writeConnectionId]) {
          expect(await status(id)).toBe('revoked');
          expect(await sealed(id)).toBe('0');
        }
        expect(await view(owner, made.adAccountId)).toMatchObject({ connectionStatus: 'revoked', canRunAds: false, writeEnabled: false });
        // The account's row stays until its history is deleted; deleting it removes the row and leaves no write connection open.
        const removed = await callAs(owner, 'ads/deleteHistory', { adAccountId: made.adAccountId, idempotencyKey: key() });
        expect(removed).toMatchObject({ status: 200, body: { removed: true } });
      });

      it('closes a write connection that outlives its read connection when the account is removed', async () => {
        await open();
        const made = await withWrite('Gỡ tài khoản');
        // The read connection alone is closed (the generic way), the write connection is still open; removing the account closes it.
        expect((await callAs(owner, 'channels/disconnect', { connectionId: made.connectionId, idempotencyKey: key() })).status).toBe(200);
        expect(await status(made.writeConnectionId)).toBe('active');
        const removed = await callAs(owner, 'ads/deleteHistory', { adAccountId: made.adAccountId, idempotencyKey: key() });
        expect(removed).toMatchObject({ status: 200, body: { removed: true } });
        expect(await status(made.writeConnectionId)).toBe('revoked');
        expect(await sealed(made.writeConnectionId)).toBe('0');
      });

      it('closes the write connection when the platform’s deletion request erases the account, as the system', async () => {
        await open();
        const made = await withWrite('Yêu cầu xóa');
        await worker.execute('ads.account.erase', { adAccountId: made.adAccountId }, { actor: SYSTEM, orgId });
        eraseAuditsBefore += 1;
        expect(await status(made.writeConnectionId)).toBe('revoked');
        expect(await sealed(made.writeConnectionId)).toBe('0');
        expect(await row(`SELECT 1 FROM crove_ads.ad_account WHERE org_id = $1 AND id = $2`, [orgId, made.adAccountId])).toEqual([]);
      });

      it('lets only a signed-in owner attach a live write connection of the account’s own twin, and only while the switch is on', async () => {
        await open();
        const made = await connect('Cổng kết nối ghi');
        const twin = await unattachedWrite(made.adAccountId);
        const attach = 'UPDATE crove_ads.ad_account SET write_connection_id = $3 WHERE org_id = $1 AND id = $2';
        const refusedWith = (c: pg.Client | pg.PoolClient, params: unknown[], code: string, message: string) => expect(c.query(attach, params)).rejects.toMatchObject({ code, message: expect.stringContaining(message) });
        // Nobody but the signed-in owner, whatever they attach.
        for (const who of [adminAccount, member, viewer, 'system'] as const) await inContext(who, (c) => refusedWith(c, [orgId, made.adAccountId, twin], '42501', 'ADS_WRITE_CONNECTION_FORBIDDEN'));
        // A connection that is not this account's own write twin, or is not live: the read connection (or another account's), a Social
        // connection, another platform's, another platform account's, a closed one.
        const other = await connect('Cổng kết nối ghi hai');
        const otherTwin = await unattachedWrite(other.adAccountId);
        const insert = async (provider: string, external: string) => {
          const id = randomUUID();
          await row(`INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, $3, $4, 'Sai', $5)`, [orgId, id, provider, external, owner.userId]);
          return id;
        };
        const externalOf = async (adAccountId: string) => (await row<{ e: string }>(`SELECT external_account_id AS e FROM crove_ads.ad_account WHERE org_id = $1 AND id = $2`, [orgId, adAccountId]))[0]?.e as string;
        const wrong = [made.connectionId, other.connectionId, otherTwin, await insert('metawrite_ads', await externalOf(made.adAccountId)), await insert('sandboxwrite_ads', `elsewhere-${randomUUID()}`)];
        for (const connectionId of wrong) await inContext(owner, (c) => refusedWith(c, [orgId, made.adAccountId, connectionId], '22023', 'ADS_WRITE_CONNECTION_INVALID'));
        await api.execute('kernel.channel.disconnect', { connectionId: otherTwin }, { actor: asOwner(), orgId });
        await inContext(owner, (c) => refusedWith(c, [orgId, other.adAccountId, otherTwin], '22023', 'ADS_WRITE_CONNECTION_INVALID'));
        // Only while the org's switch is on.
        await closed();
        await inContext(owner, (c) => refusedWith(c, [orgId, made.adAccountId, twin], '55000', 'ADS_WRITE_OFF'));
        await open();
        await inContext(owner, (c) => c.query(attach, [orgId, made.adAccountId, twin]), true);
        expect(await attached(made.adAccountId)).toBe(twin);
      });

      it('clears or replaces a write connection only once it is closed, and removes an account row only with it closed', async () => {
        await open();
        const made = await withWrite('Chỉ gỡ khi đã đóng');
        const clear = 'UPDATE crove_ads.ad_account SET write_connection_id = NULL, write_granted_by_hash = NULL WHERE org_id = $1 AND id = $2';
        const params = [orgId, made.adAccountId];
        // Open: nobody clears it, so no row forgets a token that is still sealed.
        for (const who of [owner, adminAccount, 'system'] as const) {
          await inContext(who, (c) => expect(c.query(clear, params)).rejects.toMatchObject({ code: '55000', message: expect.stringContaining('ADS_WRITE_CONNECTION_OPEN') }));
        }
        // Nor is the row removed (the read connection is closed first: the definer refuses an open one on its own).
        expect((await callAs(owner, 'channels/disconnect', { connectionId: made.connectionId, idempotencyKey: key() })).status).toBe(200);
        const remove = 'SELECT removed FROM crove_ads.account_history_delete($1::uuid, true, NULL)';
        await inContext(owner, (c) => expect(c.query(remove, [made.adAccountId])).rejects.toMatchObject({ code: '55000', message: expect.stringContaining('ADS_WRITE_CONNECTION_OPEN') }));
        // Closed: an owner, an admin or the system clear it; a member or a viewer still cannot; the row can go.
        await api.execute('kernel.channel.disconnect', { connectionId: made.writeConnectionId }, { actor: asOwner(), orgId });
        for (const who of [member, viewer] as const) {
          await inContext(who, (c) => expect(c.query(clear, params)).rejects.toMatchObject({ code: '42501', message: expect.stringContaining('ADS_WRITE_CONNECTION_FORBIDDEN') }));
        }
        for (const who of [owner, adminAccount, 'system'] as const) {
          await inContext(who, async (c) => {
            await c.query(clear, params);
          });
        }
        await inContext(owner, async (c) => expect((await c.query(remove, [made.adAccountId])).rows[0]).toMatchObject({ removed: true }));
      });

      it('closes a write connection no account refers to when writing is switched off, and one of an account when it is withdrawn', async () => {
        await open();
        const made = await connect('Kết nối chưa gắn');
        const second = await connect('Kết nối chưa gắn hai');
        const orphan = await unattachedWrite(made.adAccountId);
        const orphanTwo = await unattachedWrite(second.adAccountId);
        for (const id of [orphan, orphanTwo]) {
          expect(await status(id)).toBe('active');
          expect(await sealed(id)).toBe('1');
        }
        expect(await attached(made.adAccountId)).toBeNull();
        // Withdrawing one account closes the connection of its own platform account, attached or not, and the other's stays.
        const one = await callAs(owner, 'ads/disableAccountWrite', { adAccountId: made.adAccountId, idempotencyKey: key() });
        expect(one).toMatchObject({ status: 200, body: { connectionsClosed: 1 } });
        expect(await status(orphan)).toBe('revoked');
        expect(await sealed(orphan)).toBe('0');
        expect(await status(orphanTwo)).toBe('active');
        // Switching writing off closes every open write connection of the org, whether or not an account refers to it.
        const off = await callAs(owner, 'ads/writeDisable', { idempotencyKey: key() });
        expect(off.status, JSON.stringify(off.body)).toBe(200);
        expect(off.body.connectionsClosed).toBeGreaterThanOrEqual(1);
        expect(await status(orphanTwo)).toBe('revoked');
        expect(await sealed(orphanTwo)).toBe('0');
        expect((await row<{ n: string }>(`SELECT count(*)::text AS n FROM crove_kernel.channel_connection WHERE org_id = $1 AND provider = 'sandboxwrite_ads' AND status <> 'revoked'`, [orgId]))[0]?.n).toBe('0');
        expect((await row<{ n: string }>(`SELECT count(*)::text AS n FROM crove_kernel.credential c JOIN crove_kernel.channel_connection k ON k.org_id = c.org_id AND k.id = c.connection_id WHERE c.org_id = $1 AND k.provider = 'sandboxwrite_ads'`, [orgId]))[0]?.n).toBe('0');
      });

      it('refuses an attaching that waits behind a switch-off, and leaves nothing attached', async () => {
        await open();
        const made = await connect('Đua với việc tắt');
        const twin = await unattachedWrite(made.adAccountId);
        await inContext(owner, async (c) => {
          // The switch-off holds the setting (it locks it FOR UPDATE) and has not committed yet; the attaching reads it FOR SHARE and waits.
          await c.query('UPDATE crove_ads.ad_org_setting SET write_enabled = false, launches_blocked = true WHERE org_id = $1', [orgId]);
          const pending = api.execute('ads.account.link_write', { connectionId: twin }, { actor: asOwner(), orgId }).then(
            () => null,
            (error: unknown) => error,
          );
          await sleep(500);
          await c.query('COMMIT');
          expect(await pending).toMatchObject({ code: 'ADS_WRITE_OFF' });
        });
        expect(await attached(made.adAccountId)).toBeNull();
        await open();
      });

      it('gives an account whose read connection was closed no write connection from a sign-in made for another, and closes the one it made', async () => {
        await open();
        const made = await withWrite('Đã ngắt đọc');
        expect((await callAs(adminAccount, 'ads/disconnectAccount', { adAccountId: made.adAccountId, idempotencyKey: key() })).status).toBe(200);
        expect(await status(made.connectionId)).toBe('revoked');
        expect(await status(made.writeConnectionId)).toBe('revoked');
        // The owner connects it to run ads (as the platform's dialog would for every account it reached): refused, and not left open.
        expect(await connectWrite(owner, made.adAccountId)).toMatchObject({ status: 409, body: { code: 'ADS_WRITE_NEEDS_READ' } });
        expect(await status(made.writeConnectionId)).toBe('revoked');
        expect(await sealed(made.writeConnectionId)).toBe('0');
        expect(await view(owner, made.adAccountId)).toMatchObject({ canRunAds: false, connectionStatus: 'revoked' });
        // The query the sign-in asks first leaves it out too.
        const external = (await row<{ e: string }>(`SELECT external_account_id AS e FROM crove_ads.ad_account WHERE org_id = $1 AND id = $2`, [orgId, made.adAccountId]))[0]?.e as string;
        const live = await connect('Còn đọc');
        const liveExternal = (await row<{ e: string }>(`SELECT external_account_id AS e FROM crove_ads.ad_account WHERE org_id = $1 AND id = $2`, [orgId, live.adAccountId]))[0]?.e as string;
        expect(await api.query('ads.account.write_ready', { provider: 'sandboxwrite_ads', externalAccountIds: [external, liveExternal, 'never-linked'] }, { actor: asOwner(), orgId })).toEqual([liveExternal]);
        await expect(api.query('ads.account.write_ready', { provider: 'sandboxwrite_ads', externalAccountIds: [liveExternal] }, { actor: { type: 'user', userId: adminAccount.userId, aal: 'aal1', sessionId: randomUUID() }, orgId })).rejects.toMatchObject({ status: 403 });
      });

      it('closes a write grant the platform’s deletion request names: a write-only one leaves the account, one with the read grant erases it', async () => {
        await open();
        // Somebody else granted the read connection; the person who asks granted the write one only.
        const onlyWrite = await withWrite('Chỉ quyền ghi của người xin xóa');
        await row(`UPDATE crove_ads.ad_account SET granted_by_hash = $3 WHERE org_id = $1 AND id = $2`, [orgId, onlyWrite.adAccountId, platformUserHash(META_SECRET, '6102')]);
        await api.execute('ads.account.link_write', { connectionId: onlyWrite.writeConnectionId, grantedByHash: platformUserHash(META_SECRET, '6101') }, { actor: asOwner(), orgId });
        // The account is allowed to run ads: the closing as the system must not touch the flag (the switch guard refuses a system update of it).
        await open([onlyWrite.adAccountId]);
        await sync(onlyWrite.connectionId);
        const code = await requestDeletion('6101');
        // The write connection is closed and its token dropped, the account forgets it; the account, its read connection and its figures stay.
        expect(await status(onlyWrite.writeConnectionId)).toBe('revoked');
        expect(await sealed(onlyWrite.writeConnectionId)).toBe('0');
        expect(await attached(onlyWrite.adAccountId)).toBeNull();
        // The flag stays (the owner withdraws it; nothing can run without a live write connection).
        expect(await row(`SELECT write_granted_by_hash, write_enabled FROM crove_ads.ad_account WHERE org_id = $1 AND id = $2`, [orgId, onlyWrite.adAccountId])).toEqual([{ write_granted_by_hash: null, write_enabled: true }]);
        expect(await view(owner, onlyWrite.adAccountId)).toMatchObject({ connectionStatus: 'active', canRunAds: false, writeConnectionStatus: null });
        expect(await sealed(onlyWrite.connectionId)).toBe('1');
        expect(Number((await row<{ n: string }>(`SELECT count(*)::text AS n FROM crove_ads.ad_spend_day WHERE org_id = $1 AND ad_account_id = $2`, [orgId, onlyWrite.adAccountId]))[0]?.n)).toBeGreaterThan(0);
        // The account stays, so it is not counted among the accounts the page says were deleted (#2366).
        expect(await adsDeletionStatus(api, code)).toMatchObject({ accounts: 0 });
        // The same person granted both: the account goes, with both connections closed.
        const both = await withWrite('Cả hai của người xin xóa');
        await row(`UPDATE crove_ads.ad_account SET granted_by_hash = $3 WHERE org_id = $1 AND id = $2`, [orgId, both.adAccountId, platformUserHash(META_SECRET, '6103')]);
        await api.execute('ads.account.link_write', { connectionId: both.writeConnectionId, grantedByHash: platformUserHash(META_SECRET, '6103') }, { actor: asOwner(), orgId });
        const second = await requestDeletion('6103');
        eraseAuditsBefore += 1;
        expect(await row(`SELECT 1 FROM crove_ads.ad_account WHERE org_id = $1 AND id = $2`, [orgId, both.adAccountId])).toEqual([]);
        for (const id of [both.connectionId, both.writeConnectionId]) {
          expect(await status(id)).toBe('revoked');
          expect(await sealed(id)).toBe('0');
        }
        expect(await adsDeletionStatus(api, second)).toMatchObject({ accounts: 1 });
      });

      // #2366: a write app of its own. Meta's user ids are app-scoped and the hash that finds a person's grants is keyed with the app's
      // secret, so the callback verifies a request against the write app's secret too, and the write grant of a person is found by the
      // hash keyed with it, whichever app they removed.
      it('verifies a deletion request against the write app’s secret too, and finds the write grant by the hash keyed with it', async () => {
        const READ_APP = 'meta-app-secret';
        const WRITE_APP = 'meta-write-app-secret';
        const apps = { ads: READ_APP, adsWrite: WRITE_APP };
        const form = (secret: string, userId: string) => {
          const encoded = Buffer.from(JSON.stringify({ algorithm: 'HMAC-SHA256', issued_at: Math.floor(Date.now() / 1000), user_id: userId })).toString('base64url');
          return new URLSearchParams({ signed_request: `${createHmac('sha256', secret).update(encoded).digest('base64url')}.${encoded}` }).toString();
        };
        const ask = async (secret: string, userId: string) => {
          const accepted = await acceptMetaDeletion(api, apps, form(secret, userId));
          expect(accepted.status).toBe(200);
          await runAdsDeletions({ runtime: worker, workerDb });
          return (accepted as { code: string }).code;
        };
        await open();
        const made = await withWrite('Ứng dụng ghi riêng');
        // The read grant was made through the read app by one person, the write grant through the write app by another (or the same
        // one: their ids under the two apps are different numbers, and so are the hashes).
        await row(`UPDATE crove_ads.ad_account SET granted_by_hash = $3 WHERE org_id = $1 AND id = $2`, [orgId, made.adAccountId, platformUserHash(READ_APP, '8001')]);
        await api.execute('ads.account.link_write', { connectionId: made.writeConnectionId, grantedByHash: platformUserHash(WRITE_APP, '9001') }, { actor: asOwner(), orgId });
        await sync(made.connectionId);
        // A request signed by neither app is refused, as before.
        expect(await acceptMetaDeletion(api, apps, form('some-other-secret', '9001'))).toEqual({ status: 401, code: 'DELETION_SIGNATURE' });
        // Signed by the write app for an id that granted nothing there (the read person's id): verified, and it finds nothing.
        await ask(WRITE_APP, '8001');
        expect(await status(made.writeConnectionId)).toBe('active');
        expect(await status(made.connectionId)).toBe('active');
        expect(await attached(made.adAccountId)).toBe(made.writeConnectionId);
        // Signed by the write app for the person who granted the write connection: it is closed and forgotten, the account stays for the
        // read grant, and the read connection and the figures are untouched.
        const code = await ask(WRITE_APP, '9001');
        expect(await status(made.writeConnectionId)).toBe('revoked');
        expect(await sealed(made.writeConnectionId)).toBe('0');
        expect(await attached(made.adAccountId)).toBeNull();
        expect(await status(made.connectionId)).toBe('active');
        expect(await sealed(made.connectionId)).toBe('1');
        expect(Number((await row<{ n: string }>(`SELECT count(*)::text AS n FROM crove_ads.ad_spend_day WHERE org_id = $1 AND ad_account_id = $2`, [orgId, made.adAccountId]))[0]?.n)).toBeGreaterThan(0);
        // The account stays, so it is not counted among the accounts the page says were deleted; the page says so in its own words.
        const done = await adsDeletionStatus(api, code);
        expect(done).toMatchObject({ accounts: 0 });
        expect(done?.completedAt).toBeInstanceOf(Date);
        // Signed by the read app for the person who granted the read connection: the account is erased as before.
        await ask(READ_APP, '8001');
        eraseAuditsBefore += 1;
        expect(await row(`SELECT 1 FROM crove_ads.ad_account WHERE org_id = $1 AND id = $2`, [orgId, made.adAccountId])).toEqual([]);
        expect(await status(made.connectionId)).toBe('revoked');
      });

      // The route itself (http.ts) with the write app's secret alone, as a deployment whose read app is not set (or whose reads are not
      // Meta's): a request signed by it is accepted and queued under the hash keyed with it; one signed by another secret is refused;
      // and with the Ads module off the route does not exist (the global auth refuses what is not mounted).
      it('mounts the callback for the write app alone, refuses another secret, and does not exist with the Ads module off', async () => {
        const WRITE_APP = 'meta-write-app-secret';
        const form = (secret: string, userId: string) => {
          const encoded = Buffer.from(JSON.stringify({ algorithm: 'HMAC-SHA256', issued_at: Math.floor(Date.now() / 1000), user_id: userId })).toString('base64url');
          return new URLSearchParams({ signed_request: `${createHmac('sha256', secret).update(encoded).digest('base64url')}.${encoded}` }).toString();
        };
        const mount = (runtime: Runtime) =>
          createHttpApp({
            config: appConfig,
            runtime,
            store: new MemoryStore(),
            authenticate: createAuthenticator(appConfig, appDb),
            pool,
            aiEnabled: false,
            channels: { broker: vault, sandbox: true, connectors: {}, publicUrl: 'https://ludy.example.test' },
            adsWriteDeletion: { appSecret: WRITE_APP },
          });
        const post = (app: ReturnType<typeof mount>, body: string) => app.request('/api/ads/meta/data-deletion', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
        const only = mount(api);
        const accepted = await post(only, form(WRITE_APP, '9002'));
        expect(accepted.status).toBe(200);
        const { confirmation_code: code } = (await accepted.json()) as { confirmation_code: string };
        expect(await row(`SELECT user_hash FROM crove_ads.deletion_request WHERE code = $1`, [code])).toEqual([{ user_hash: platformUserHash(WRITE_APP, '9002') }]);
        expect((await only.request(`/api/ads/meta/data-deletion?code=${code}`)).status).toBe(200);
        // Signed with the read app's secret, which this deployment does not hold: refused, and stored nowhere.
        expect((await post(only, form('meta-app-secret', '9003'))).status).toBe(401);
        expect(await row(`SELECT 1 FROM crove_ads.deletion_request WHERE user_hash = $1`, [platformUserHash('meta-app-secret', '9003')])).toEqual([]);
        await runAdsDeletions({ runtime: worker, workerDb });
        // The Ads module off: no route for the write app's secret either (the request is refused, and nothing is stored).
        const off = mount(new Runtime(appDb, { manifests: TEST_MANIFESTS, absentModules: ['ads'] }).register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: null }) }));
        expect((await post(off, form(WRITE_APP, '9004'))).status).not.toBe(200);
        expect(await row(`SELECT 1 FROM crove_ads.deletion_request WHERE user_hash = $1`, [platformUserHash(WRITE_APP, '9004')])).toEqual([]);
      });

      // The owner's own setup is one app for the reads, the writing and the Pages: the three secrets are the same, the Ads side is asked
      // once, and a person who asks again while their conversations request is still open is linked to it (the status page waits for both).
      it('asks the Ads side once when the read, write and Pages apps are one, and keeps the conversations request linked', async () => {
        const ONE = 'meta-one-app-secret';
        const apps = { ads: ONE, adsWrite: ONE, conversations: ONE };
        const form = (userId: string) => {
          const encoded = Buffer.from(JSON.stringify({ algorithm: 'HMAC-SHA256', issued_at: Math.floor(Date.now() / 1000), user_id: userId })).toString('base64url');
          return new URLSearchParams({ signed_request: `${createHmac('sha256', ONE).update(encoded).digest('base64url')}.${encoded}` }).toString();
        };
        const first = await acceptMetaDeletion(api, apps, form('9101'));
        expect(first.status).toBe(200);
        // The Ads side is handled; the conversations side is still open.
        await runAdsDeletions({ runtime: worker, workerDb });
        const again = await acceptMetaDeletion(api, apps, form('9101'));
        expect(again.status).toBe(200);
        const code = (again as { code: string }).code;
        // The Ads side's new request is handled; the conversations side still holds the old one, linked to this code, so the page is not
        // "done" (a link that was never made would leave the page with the Ads side alone, which is complete).
        await runAdsDeletions({ runtime: worker, workerDb });
        expect(await metaDeletionStatus(api, code)).toMatchObject({ completedAt: null });
      });
    });

    // #2378: the deterministic spend flags. Owners and admins read them; the figures are seeded in the second org (so no other account
    // reads yesterday) at a fixed instant, and the flags are the ones the rules call for: no cap, no pace or day flag; a cost per result that
    // jumped is flagged without a cap; a cap brings the pace and the day flag, with the numbers they are based on.
    describe('the spend flags (#2378)', () => {
      const NOW = '2026-11-10T05:00:00.000Z';
      const asOutsider = () => ({ type: 'user' as const, userId: outsider.userId, aal: 'aal1' as const, sessionId: outsider.session });
      // Runs `text` ($1 the second org, $2 the account, $3 its owner) as the signed-in owner of the second org (the guard of the caps refuses every
      // other context), committed.
      const capsFor = async (adAccountId: string, text: string) => {
        const c = await pool.connect();
        try {
          await c.query('BEGIN');
          const token = mintContextToken(process.env.CROVE_CONTEXT_TOKEN_KEY ?? '', { userId: outsider.userId, orgId: otherOrgId, sessionId: null, aal: 'aal1', mfaAt: null });
          await c.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [otherOrgId, token]);
          await c.query('INSERT INTO crove_ads.ad_org_setting (org_id) VALUES ($1) ON CONFLICT DO NOTHING', [otherOrgId]);
          await c.query(text, [otherOrgId, adAccountId, outsider.userId]);
          await c.query('COMMIT');
        } finally {
          await c.query('ROLLBACK').catch(() => undefined);
          c.release();
        }
      };
      it('raises exactly the flags the seeded figures call for, for owners and admins only', async () => {
        // Members and viewers do not read what shows spend.
        for (const who of [member, viewer]) expect((await callAs(who, 'ads/flags', undefined)).status, who.email).toBe(403);
        expect((await callAs(owner, 'ads/flags', undefined)).status).toBe(200);
        expect((await callAs(adminAccount, 'ads/flags', undefined)).status).toBe(200);
        // An account of the second org with figures: VND, Ho Chi Minh City, synced through the 9th, the figures of the 1st to the 9th.
        const made = await rpc('ads/connectSandbox', await tokenFor(outsider), { displayName: 'Cờ chi tiêu', idempotencyKey: randomUUID() }, otherSlug);
        expect(made.status, JSON.stringify(made.body)).toBe(200);
        const mine = made.body.adAccountId as string;
        await row(`UPDATE crove_ads.ad_account SET synced_through = NULL WHERE org_id = $1 AND id <> $2`, [otherOrgId, mine]);
        await row(`UPDATE crove_ads.ad_account SET currency = 'VND', time_zone = 'Asia/Ho_Chi_Minh', result_kind = 'purchase', synced_through = '2026-11-09' WHERE org_id = $1 AND id = $2`, [otherOrgId, mine]);
        const entity = (await row<{ legal_entity_id: string }>(`SELECT legal_entity_id FROM crove_ads.ad_account WHERE org_id = $1 AND id = $2`, [otherOrgId, mine]))[0]?.legal_entity_id as string;
        const seed = (level: 'account' | 'campaign', objectId: string, name: string, day: string, spend: string, purchases: string | null) =>
          row(
            `INSERT INTO crove_ads.ad_spend_day (org_id, ad_account_id, legal_entity_id, level, external_object_id, object_name, day, currency, spend, impressions, clicks, results)
             VALUES ($1, $2, $3, $4, $5, $6, $7, 'VND', $8, 0, 0, $9::jsonb)`,
            [otherOrgId, mine, entity, level, objectId, name, day, spend, purchases === null ? '{}' : JSON.stringify({ purchase: purchases })],
          );
        for (let d = 1; d <= 9; d++) {
          const day = `2026-11-${String(d).padStart(2, '0')}`;
          await seed('account', 'acct', 'Cờ chi tiêu', day, '10000', null);
          // Campaign A cost 1 000 a result up to the 6th and 3 000 for the last 3 days; campaign B stays at 1 000.
          await seed('campaign', 'c1', 'Chiến dịch A', day, d <= 6 ? '100000' : '300000', '100');
          await seed('campaign', 'c2', 'Chiến dịch B', day, '100000', '100');
        }
        const flagsOf = async () => ((await api.query('ads.flags', { now: NOW }, { actor: asOutsider(), orgId: otherOrgId })) as Array<Record<string, unknown>>).filter((f) => f.adAccountId === mine);
        // No cap on this account: no pace flag and no day flag; only the cost per result that jumped, from the account's own figures.
        const before = await flagsOf();
        expect(before.map((f) => f.kind)).toEqual(['cpr']);
        expect(before[0]).toMatchObject({ campaignId: 'c1', campaignName: 'Chiến dịch A', currency: 'VND', day: '2026-11-09', recentCost: '3000', medianCost: '1000', ratio: '3.00', recentResults: '300', historyDays: 6 });
        // A monthly cap of 250 000 and a daily cap of 5 000 on the account (the signed-in owner sets them): the pace and the day flag, in decimal.
        const caps = (text: string) => capsFor(mine, text);
        await caps(`INSERT INTO crove_ads.ad_spend_cap (org_id, scope, ad_account_id, period, amount, currency, set_by) VALUES ($1, 'account', $2, 'monthly', '250000', 'VND', $3), ($1, 'account', $2, 'daily', '5000', 'VND', $3)`);
        const after = await flagsOf();
        expect(after.map((f) => f.kind).sort()).toEqual(['cpr', 'day', 'pace']);
        expect(after.find((f) => f.kind === 'pace')).toEqual({ kind: 'pace', scope: 'account', adAccountId: mine, accountName: 'Cờ chi tiêu', currency: 'VND', skippedAccounts: 0, cap: '250000', spent: '90000', projected: '300000', elapsedDays: 9, daysInMonth: 30 });
        expect(after.find((f) => f.kind === 'day')).toEqual({ kind: 'day', scope: 'account', adAccountId: mine, accountName: 'Cờ chi tiêu', currency: 'VND', skippedAccounts: 0, period: 'daily', cap: '5000', share: '5000', day: '2026-11-09', spend: '10000', ratio: '2.00' });
        // A cap above the projection and above the day's spend raises neither (a raised cap is the latest row of its key).
        await caps(`INSERT INTO crove_ads.ad_spend_cap (org_id, scope, ad_account_id, period, amount, currency, set_by) VALUES ($1, 'account', $2, 'monthly', '300000', 'VND', $3), ($1, 'account', $2, 'daily', '9000', 'VND', $3)`);
        expect((await flagsOf()).map((f) => f.kind)).toEqual(['cpr']);
        // The 1st of the next month: yesterday is the last day of November, which the loader must read (it starts at the month of yesterday), so
        // a day over its share is flagged on that day too; no pace is judged on the 1st.
        for (let d = 10; d <= 30; d++) await seed('account', 'acct', 'Cờ chi tiêu', `2026-11-${String(d).padStart(2, '0')}`, '10000', null);
        await row(`UPDATE crove_ads.ad_account SET synced_through = '2026-11-30' WHERE org_id = $1 AND id = $2`, [otherOrgId, mine]);
        await caps(`INSERT INTO crove_ads.ad_spend_cap (org_id, scope, ad_account_id, period, amount, currency, set_by) VALUES ($1, 'account', $2, 'monthly', '250000', 'VND', $3), ($1, 'account', $2, 'daily', '5000', 'VND', $3)`);
        const firstOfMonth = ((await api.query('ads.flags', { now: '2026-12-01T05:00:00.000Z' }, { actor: asOutsider(), orgId: otherOrgId })) as Array<Record<string, unknown>>).filter((f) => f.adAccountId === mine);
        expect(firstOfMonth.map((f) => f.kind)).toEqual(['day']);
        expect(firstOfMonth[0]).toMatchObject({ day: '2026-11-30', spend: '10000', ratio: '2.00' });
        // A flag moves nothing: the cap rows and the account's flags of running ads are as they were.
        expect(await row(`SELECT write_enabled FROM crove_ads.ad_account WHERE org_id = $1 AND id = $2`, [otherOrgId, mine])).toEqual([{ write_enabled: false }]);
      });

      // The thresholds are an org setting (#2378 slice 2): owners and admins read and set them, the contract and the database hold the bounds,
      // and the row is written by owners and admins alone, whoever reaches it.
      it('stores the thresholds an owner or admin sets, bounds them in the contract and in the database, and holds the row to owners and admins', async () => {
        const nulls = { paceMinDays: null, dayFactor: null, cprFactor: null, cprMinResults: null, cprMinHistoryDays: null };
        const defaults = { paceMinDays: 3, dayFactor: '1.5', cprFactor: '1.5', cprMinResults: 5, cprMinHistoryDays: 5 };
        expect(await callAs(owner, 'ads/flagSettings', undefined)).toMatchObject({ status: 200, body: { set: nulls, defaults, setAt: null } });
        for (const who of [member, viewer]) {
          expect((await callAs(who, 'ads/flagSettings', undefined)).status, who.email).toBe(403);
          expect((await callAs(who, 'ads/setFlagSettings', { ...nulls, idempotencyKey: key() })).status, who.email).toBe(403);
        }
        // An admin sets some of them; a null is the default.
        const set = { paceMinDays: 4, dayFactor: '2.5', cprFactor: null, cprMinResults: 20, cprMinHistoryDays: null };
        const saved = await callAs(adminAccount, 'ads/setFlagSettings', { ...set, idempotencyKey: key() });
        expect(saved).toMatchObject({ status: 200, body: { set, defaults } });
        expect(typeof saved.body.setAt).toBe('string');
        expect(await callAs(owner, 'ads/flagSettings', undefined)).toMatchObject({ status: 200, body: { set, defaults } });
        // One row for the org, stamped with who set it; the audit row names the change.
        expect(await row(`SELECT count(*)::int AS n, bool_and(set_by = $2) AS mine FROM crove_ads.ad_flag_setting WHERE org_id = $1`, [orgId, adminAccount.userId])).toEqual([{ n: 1, mine: true }]);
        const audit = await row<{ detail: Record<string, unknown> }>(`SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'ads.flag_settings_set' AND outcome = 'ok' ORDER BY id DESC LIMIT 1`, [orgId]);
        expect(audit[0]?.detail).toMatchObject({ previous: nulls, set });
        // The contract refuses what is out of range.
        for (const bad of [{ paceMinDays: 0 }, { paceMinDays: 16 }, { dayFactor: '1' }, { dayFactor: '1.0' }, { cprFactor: '10.01' }, { cprFactor: '2.555' }, { cprMinResults: 0 }, { cprMinHistoryDays: 2 }, { cprMinHistoryDays: 15 }]) {
          const refusedCall = await callAs(owner, 'ads/setFlagSettings', { ...set, ...bad, idempotencyKey: key() });
          expect(refusedCall.status, JSON.stringify(bad)).toBeGreaterThanOrEqual(400);
          expect(refusedCall.status, JSON.stringify(bad)).toBeLessThan(500);
        }
        // The database holds the same bounds, whoever writes.
        for (const bad of ['pace_min_days = 0', 'pace_min_days = 16', 'day_factor = 1', 'day_factor = 10.01', 'day_factor = 1.555', 'cpr_factor = 2.555', 'cpr_factor = 0.5', 'cpr_min_results = 0', 'cpr_min_history_days = 2', 'cpr_min_history_days = 15']) {
          await expect(row(`UPDATE crove_ads.ad_flag_setting SET ${bad} WHERE org_id = $1`, [orgId]), bad).rejects.toMatchObject({ code: '23514' });
        }
        // The row policies: a member and a viewer change and delete nothing, and insert nothing, in SQL as well; an owner's context writes it.
        for (const who of [member, viewer]) {
          await inContext(who, async (c) => {
            expect((await c.query('UPDATE crove_ads.ad_flag_setting SET pace_min_days = 9 WHERE org_id = $1', [orgId])).rowCount, who.email).toBe(0);
            expect((await c.query('DELETE FROM crove_ads.ad_flag_setting WHERE org_id = $1', [orgId])).rowCount, who.email).toBe(0);
          });
          await inContext(who, (c) => refused(c, 'INSERT INTO crove_ads.ad_flag_setting (org_id) VALUES ($1)', [orgId], 'row-level security'));
        }
        await inContext(owner, async (c) => {
          expect((await c.query('UPDATE crove_ads.ad_flag_setting SET pace_min_days = 4 WHERE org_id = $1', [orgId])).rowCount).toBe(1);
        });
        expect((await callAs(owner, 'ads/flagSettings', undefined)).body.set).toEqual(set);
        // Back to the defaults.
        expect(await callAs(owner, 'ads/setFlagSettings', { ...nulls, idempotencyKey: key() })).toMatchObject({ status: 200, body: { set: nulls, defaults } });
      });

      it('applies the thresholds to the flags and to the items of Home, which only owners and admins get, and a threshold edit moves nothing else', async () => {
        const made = await rpc('ads/connectSandbox', await tokenFor(outsider), { displayName: 'Ngưỡng cờ', idempotencyKey: randomUUID() }, otherSlug);
        expect(made.status, JSON.stringify(made.body)).toBe(200);
        const mine = made.body.adAccountId as string;
        // Only this account is judged: the others of the org (the first test's) have not read yesterday.
        await row(`UPDATE crove_ads.ad_account SET synced_through = NULL WHERE org_id = $1 AND id <> $2`, [otherOrgId, mine]);
        await row(`UPDATE crove_ads.ad_account SET currency = 'VND', time_zone = 'Asia/Ho_Chi_Minh', result_kind = 'purchase', synced_through = '2026-11-09' WHERE org_id = $1 AND id = $2`, [otherOrgId, mine]);
        const entity = (await row<{ legal_entity_id: string }>(`SELECT legal_entity_id FROM crove_ads.ad_account WHERE org_id = $1 AND id = $2`, [otherOrgId, mine]))[0]?.legal_entity_id as string;
        for (let d = 1; d <= 9; d++) {
          const day = `2026-11-${String(d).padStart(2, '0')}`;
          await row(
            `INSERT INTO crove_ads.ad_spend_day (org_id, ad_account_id, legal_entity_id, level, external_object_id, object_name, day, currency, spend, impressions, clicks, results)
             VALUES ($1, $2, $3, 'account', 'acct', 'Ngưỡng cờ', $4, 'VND', '10000', 0, 0, '{}'::jsonb),
                    ($1, $2, $3, 'campaign', 'c1', 'Chiến dịch A', $4, 'VND', $5, 0, 0, '{"purchase":"100"}'::jsonb)`,
            [otherOrgId, mine, entity, day, d <= 6 ? '100000' : '300000'],
          );
        }
        await capsFor(mine, `INSERT INTO crove_ads.ad_spend_cap (org_id, scope, ad_account_id, period, amount, currency, set_by) VALUES ($1, 'account', $2, 'monthly', '250000', 'VND', $3), ($1, 'account', $2, 'daily', '5000', 'VND', $3)`);
        const flags = async () => ((await api.query('ads.flags', { now: NOW }, { actor: asOutsider(), orgId: otherOrgId })) as Array<{ kind: string; adAccountId: string }>).filter((f) => f.adAccountId === mine);
        const today = async (actor: Parameters<typeof api.query>[2]['actor'] = asOutsider()) => (await api.query('ads.today', { now: NOW }, { actor, orgId: otherOrgId })) as TodayItem[];
        const mineOnly = async () => (await today()).filter((i) => i.id.includes(mine));
        const setThresholds = (set: Record<string, unknown>) => api.execute('ads.flag_settings_set', set, { actor: asOutsider(), orgId: otherOrgId });
        const nulls = { paceMinDays: null, dayFactor: null, cprFactor: null, cprMinResults: null, cprMinHistoryDays: null };
        const switches = () => row(`SELECT write_enabled, launches_blocked, updated_at::text AS updated_at FROM crove_ads.ad_org_setting WHERE org_id = $1`, [otherOrgId]);
        const switchesBefore = await switches();
        // The defaults: the pace, the day and the cost per result are flagged, and Home lists them for the owner, the pace first.
        expect((await flags()).map((f) => f.kind).sort()).toEqual(['cpr', 'day', 'pace']);
        // (The org's own caps from the tests before raise org-level items too; the list is valid whole, and this account's items are the ones judged.)
        expect(zTodayItems.safeParse(await today()).success).toBe(true);
        const items = await mineOnly();
        expect(items.map((i) => i.id)).toEqual([`pace:${mine}`, `day:${mine}:daily`, `cpr:${mine}:c1`]);
        expect(items[0]).toMatchObject({ kind: 'flag', app: 'ads', title: { key: 'ads.paceAccount', params: { account: 'Ngưỡng cờ' } }, amount: '300000', currency: 'VND', severity: 'warn', href: '/ads' });
        // The thresholds the org sets: 9 days over are not enough for a minimum of 10, a day at exactly 2.00 times its share and a cost per result at
        // exactly 3.00 times its median are not above a factor of 2 and of 3. Nothing is flagged, in the Ads screen or in Home.
        await setThresholds({ ...nulls, paceMinDays: 10, dayFactor: '2', cprFactor: '3' });
        expect(await flags()).toEqual([]);
        expect(await mineOnly()).toEqual([]);
        // A factor a little under those flags them again; a minimum of results above the 300 of the last days holds the campaign back.
        await setThresholds({ ...nulls, paceMinDays: 9, dayFactor: '1.99', cprFactor: '2.99' });
        expect((await flags()).map((f) => f.kind).sort()).toEqual(['cpr', 'day', 'pace']);
        await setThresholds({ ...nulls, cprMinResults: 400 });
        expect((await flags()).map((f) => f.kind).sort()).toEqual(['day', 'pace']);
        await setThresholds(nulls);
        expect((await flags()).map((f) => f.kind).sort()).toEqual(['cpr', 'day', 'pace']);
        // Members and viewers get an empty list, not a refusal, though the flags are there.
        await row(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'viewer')`, [otherOrgId, member.userId, viewer.userId]);
        try {
          for (const who of [member, viewer]) {
            // A first call in the org binds the session to it (the runtime checks that), then the read.
            expect((await rpc('ads/accounts', await tokenFor(who), undefined, otherSlug)).status, who.email).toBe(200);
            expect(await today({ type: 'user', userId: who.userId, aal: 'aal1', sessionId: who.session }), who.email).toEqual([]);
          }
        } finally {
          await row(`DELETE FROM crove_kernel.tenant_member WHERE org_id = $1 AND user_id = ANY ($2::uuid[])`, [otherOrgId, [member.userId, viewer.userId]]);
        }
        // Editing a threshold touches no switch: the switches' own record (and the proposal that unblocks launches reads it) is as it was.
        expect(await switches()).toEqual(switchesBefore);
      });
    });
  });

  // A3 (#2219): an account whose token the platform refused is paused and its owners told; connecting again resumes it with
  // no day lost; an owner or admin deletes the stored history; Meta's data deletion request erases what a person granted.
  describe('paused accounts, deleting history and the deletion callback (A3)', () => {
    const SECRET_META = 'meta-app-secret';
    const expiring: Readonly<Record<string, AdPlatform>> = {
      sandbox_ads: {
        ...(sandbox.sandbox_ads as AdPlatform),
        readDaily: async () => {
          throw new AdPlatformError('token_expired', '190');
        },
      },
    };
    const daysOf = async (adAccountId: string, org = orgId) =>
      (await row<{ day: string }>(`SELECT DISTINCT to_char(day, 'YYYY-MM-DD') AS day FROM crove_ads.ad_spend_day WHERE org_id = $1 AND ad_account_id = $2 ORDER BY 1`, [org, adAccountId])).map((r) => r.day);
    const notices = async (kind: string) =>
      row<{ user_id: string; detail: Record<string, string> }>(`SELECT user_id, detail FROM crove_kernel.notification WHERE org_id = $1 AND kind = $2 ORDER BY created_at, id`, [orgId, kind]);
    // Meta's signed request: the payload and its HMAC-SHA256 under the app secret, both base64url.
    const signed = (userId: string, secret = SECRET_META, payload: Record<string, unknown> = { algorithm: 'HMAC-SHA256', issued_at: Math.floor(Date.now() / 1000), user_id: userId }) => {
      const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
      return `${createHmac('sha256', secret).update(encoded).digest('base64url')}.${encoded}`;
    };
    const form = (signedRequest: string) => new URLSearchParams({ signed_request: signedRequest }).toString();
    // Links a sandbox account as the Meta user `granted` (hashed), in a given org, as that org's owner.
    // The same key is the same platform account: connecting again with it is connecting the account again. The sandbox draws every
    // figure from its token (a campaign that "did not run" that day has no row), so a new token is a new set of figures and a
    // different set of quiet days: a test that compares days before and after a reconnect hands the second login the first token.
    async function linkedAs(org: string, actor: ReturnType<typeof asOwner>, name: string, granted: string | undefined, key = `a3-${randomUUID().slice(0, 8)}`, token?: string) {
      const login = (sandbox.sandbox_ads as ReturnType<typeof sandboxAdPlatform>).connect({ displayName: name, key });
      const { externalAccountId } = login;
      const secret = token ?? login.secret;
      const sealed = vault.seal(secret, { orgId: org, provider: 'sandbox_ads', externalAccountId });
      const made = await api.execute<{ connectionId: string }>(
        'kernel.channel.connect',
        { provider: 'sandbox_ads', externalAccountId, displayName: name, scopes: [], expiresAt: null, credential: { keyId: sealed.keyId, envelope: sealed.envelope.toString('base64') } },
        { actor, orgId: org },
      );
      const linked = await api.execute<{ adAccountId: string }>('ads.account.link', { connectionId: made.connectionId, ...(granted ? { grantedByHash: platformUserHash(SECRET_META, granted) } : {}) }, { actor, orgId: org });
      return { connectionId: made.connectionId, adAccountId: linked.adAccountId, key, secret };
    }
    const outsiderActor = () => ({ type: 'user' as const, userId: outsider.userId, aal: 'aal1' as const, sessionId: outsider.session });
    const expiredEvent = async (connectionId: string) => {
      const [event] = await row<{ id: string }>(`SELECT id FROM crove_kernel.outbox_event WHERE org_id = $1 AND type = 'kernel.channel.expired' AND payload->>'connection_id' = $2`, [orgId, connectionId]);
      expect(event).toBeDefined();
      return (event as { id: string }).id;
    };

    it('pauses an account the platform refused, tells the owners and admins once, and resumes with no day lost after it is connected again', async () => {
      const { connectionId, adAccountId, key, secret } = await linkedAs(orgId, asOwner(), 'Hết hạn rồi nối lại', undefined);
      await sync(connectionId);
      const full = await daysOf(adAccountId);
      expect(full.length).toBeGreaterThan(300);
      // The platform refuses the token: the connection is expired, the account says why and since when, and the cursors stay.
      const cursors = () => row(`SELECT settled_through::text, synced_through::text FROM crove_ads.ad_account WHERE org_id = $1 AND id = $2`, [orgId, adAccountId]);
      const before = await cursors();
      await sync(connectionId, expiring);
      const paused = await view(owner, adAccountId);
      expect(paused).toMatchObject({ connectionStatus: 'expired', pausedReason: 'token_expired', lastErrorKind: 'token_expired' });
      expect(Date.now() - Date.parse(paused?.pausedSince as string)).toBeLessThan(60_000);
      expect(await cursors()).toEqual(before);
      // A paused account is not read or swept; the owners and admins (not the member or viewer) are told, once.
      expect(await sync(connectionId)).toEqual({ rows: 0, slices: 0 });
      const eventId = await expiredEvent(connectionId);
      const dispatch = () => worker.execute<{ sent: number }>('kernel.notification.dispatch', { eventId }, { actor: SYSTEM, orgId });
      // The owner and the admin; once however often the event is handled.
      expect((await dispatch()).sent).toBe(2);
      expect((await dispatch()).sent).toBe(0);
      const told = (await notices('kernel.channel_expired')).filter((n) => n.detail.provider === 'sandbox_ads');
      expect(told.map((n) => n.user_id)).toContain(owner.userId);
      expect(told.map((n) => n.user_id)).toContain(adminAccount.userId);
      expect(told.map((n) => n.user_id)).not.toContain(member.userId);
      expect(told.map((n) => n.user_id)).not.toContain(viewer.userId);
      // By the platform's id only: no name, no token.
      expect(told[0]?.detail).toEqual({ provider: 'sandbox_ads' });
      // Days pass while it is paused: the last ten of the stored figures are gone, as if the sync had missed them.
      await row(`DELETE FROM crove_ads.ad_spend_day WHERE org_id = $1 AND ad_account_id = $2 AND day > (now() AT TIME ZONE 'UTC')::date - 10`, [orgId, adAccountId]);
      await row(`UPDATE crove_ads.ad_account SET settled_through = (now() AT TIME ZONE 'UTC')::date - 40, synced_through = (now() AT TIME ZONE 'UTC')::date - 10 WHERE org_id = $1 AND id = $2`, [orgId, adAccountId]);
      // The owner connects the same platform account again: the row, its settings and its history stay, and the next sync
      // reads from the day after the last final one, so nothing between the pause and now is missing.
      const again = await linkedAs(orgId, asOwner(), 'Hết hạn rồi nối lại', undefined, key, secret);
      expect(again.adAccountId).toBe(adAccountId);
      expect(await view(owner, adAccountId)).toMatchObject({ connectionStatus: 'active', pausedSince: null, pausedReason: null });
      await sync(again.connectionId);
      // The same token draws the same figures, so the same days have a row (the newest drift in value with the minute, never in
      // whether they have one).
      expect(await daysOf(adAccountId)).toEqual(full);
    });

    it('does not carry a name or a token in the notice of an expired ad platform connection, and stays silent once it is connected again', async () => {
      const { connectionId } = await connect('Tên không vào thông báo');
      await sync(connectionId, expiring);
      const eventId = await expiredEvent(connectionId);
      expect((await worker.execute<{ sent: number }>('kernel.notification.dispatch', { eventId }, { actor: SYSTEM, orgId })).sent).toBeGreaterThan(0);
      expect(JSON.stringify(await notices('kernel.channel_expired'))).not.toMatch(/sbx_|accessToken|Tên không vào thông báo/);
      // A connection that is active again by the time the worker gets to the event is not waiting for anyone.
      const { connectionId: other } = await connect('Nối lại trước khi báo');
      await sync(other, expiring);
      const otherEvent = await expiredEvent(other);
      await row(`UPDATE crove_kernel.channel_connection SET status = 'active' WHERE org_id = $1 AND id = $2`, [orgId, other]);
      expect((await worker.execute<{ sent: number }>('kernel.notification.dispatch', { eventId: otherEvent }, { actor: SYSTEM, orgId })).sent).toBe(0);
    });

    it('deletes the stored history on request: owners and admins only, the row stays while connected, goes with a closed connection', async () => {
      const { connectionId, adAccountId } = await connect('Xóa lịch sử');
      await sync(connectionId);
      expect((await daysOf(adAccountId)).length).toBeGreaterThan(300);
      // Members, viewers and another org's owner may not, and say nothing about whether the account exists.
      for (const who of [member, viewer]) {
        const refused = await rpc('ads/deleteHistory', await tokenFor(who), { adAccountId, idempotencyKey: randomUUID() });
        expect(refused.status, who.email).toBe(403);
      }
      const foreign = await rpc('ads/deleteHistory', await tokenFor(outsider), { adAccountId, idempotencyKey: randomUUID() }, otherSlug);
      expect(foreign.status).toBe(404);
      expect((await daysOf(adAccountId)).length).toBeGreaterThan(300);
      // The owner deletes: every figure and sync run goes, the cursors go back, the account and its settings stay.
      const done = (await ok('ads/deleteHistory', owner, { adAccountId, idempotencyKey: randomUUID() })) as { days: number; runs: number; removed: boolean };
      expect(done.removed).toBe(false);
      expect(done.days).toBeGreaterThan(300);
      expect(done.runs).toBeGreaterThan(0);
      expect(await daysOf(adAccountId)).toEqual([]);
      expect(await row(`SELECT 1 FROM crove_ads.ad_sync_run WHERE org_id = $1 AND ad_account_id = $2`, [orgId, adAccountId])).toEqual([]);
      expect(await view(owner, adAccountId)).toMatchObject({ connectionStatus: 'active', syncedThrough: null, settledThrough: null, lastRunAt: null, lastErrorKind: null });
      // The audit row names the account and counts, never a figure.
      const audit = await row<{ detail: Record<string, unknown> }>(`SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'ads.account.delete_history' ORDER BY id DESC LIMIT 1`, [orgId]);
      expect(audit[0]?.detail).toMatchObject({ adAccountId, removed: false });
      // The next sync reads the 13 months again.
      await sync(connectionId);
      expect((await daysOf(adAccountId)).length).toBeGreaterThan(300);
      // A connection still open does not let the account itself go; a closed one does, and nothing of it is left.
      expect((await rpc('channels/disconnect', await tokenFor(owner), { connectionId, idempotencyKey: randomUUID() })).status).toBe(200);
      const closed = (await ok('ads/deleteHistory', owner, { adAccountId, idempotencyKey: randomUUID() })) as { removed: boolean };
      expect(closed.removed).toBe(true);
      expect(await row(`SELECT 1 FROM crove_ads.ad_account WHERE org_id = $1 AND id = $2`, [orgId, adAccountId])).toEqual([]);
      expect(await row(`SELECT 1 FROM crove_ads.ad_spend_day WHERE org_id = $1 AND ad_account_id = $2`, [orgId, adAccountId])).toEqual([]);
      expect(await view(owner, adAccountId)).toBeUndefined();
      const gone = await rpc('ads/deleteHistory', await tokenFor(owner), { adAccountId, idempotencyKey: randomUUID() });
      expect(gone.status).toBe(404);
      // The command that erases for a platform's request is the system's alone.
      const { adAccountId: other } = await connect('Chỉ hệ thống xóa');
      await expect(api.execute('ads.account.erase', { adAccountId: other }, { actor: asOwner(), orgId })).rejects.toMatchObject({ status: 403 });
    });

    it('checks Meta’s signature before anything else, and answers a verified request with a code and a status page', async () => {
      const post = (body: string) => app.request('/api/ads/meta/data-deletion', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
      // Forged, the wrong secret, the wrong algorithm, not a user id, malformed: none is stored.
      const before = await row<{ n: string }>(`SELECT count(*)::text AS n FROM crove_ads.deletion_request`);
      expect((await post(form(signed('4242', 'another-secret')))).status).toBe(401);
      expect((await post(form(signed('4242', SECRET_META, { algorithm: 'HMAC-SHA1', user_id: '4242' })))).status).toBe(401);
      expect((await post(form(signed('not-a-number')))).status).toBe(401);
      expect((await post(form(`${signed('4242').split('.')[0]}.${Buffer.from('{"algorithm":"HMAC-SHA256","user_id":"9999"}').toString('base64url')}`))).status).toBe(401);
      expect((await post(form('no-dot'))).status).toBe(401);
      // Signed by Meta but expired, with no stamp, or stamped in the future: not a request to act on (a replay of an old one).
      const nowSeconds = Math.floor(Date.now() / 1000);
      expect((await post(form(signed('4242', SECRET_META, { algorithm: 'HMAC-SHA256', issued_at: nowSeconds - 25 * 3600, user_id: '4242' })))).status).toBe(401);
      expect((await post(form(signed('4242', SECRET_META, { algorithm: 'HMAC-SHA256', user_id: '4242' })))).status).toBe(401);
      expect((await post(form(signed('4242', SECRET_META, { algorithm: 'HMAC-SHA256', issued_at: String(nowSeconds), user_id: '4242' })))).status).toBe(401);
      expect((await post(form(signed('4242', SECRET_META, { algorithm: 'HMAC-SHA256', issued_at: nowSeconds + 3600, user_id: '4242' })))).status).toBe(401);
      expect((await post('other=1')).status).toBe(400);
      expect((await post('')).status).toBe(400);
      expect(await row(`SELECT count(*)::text AS n FROM crove_ads.deletion_request`)).toEqual(before);
      // A verified one: a code of 128 random bits and the status page's address; the user id is stored nowhere.
      const accepted = await post(form(signed('4242')));
      expect(accepted.status).toBe(200);
      const body = (await accepted.json()) as { url: string; confirmation_code: string };
      expect(body.confirmation_code).toMatch(/^[0-9a-f]{32}$/);
      expect(body.url).toBe(`${appConfig.PUBLIC_URL}/api/ads/meta/data-deletion?code=${body.confirmation_code}`);
      const stored = await row<{ user_hash: string; completed_at: string | null }>(`SELECT user_hash, completed_at FROM crove_ads.deletion_request WHERE code = $1`, [body.confirmation_code]);
      expect(stored).toEqual([{ user_hash: platformUserHash(SECRET_META, '4242'), completed_at: null }]);
      expect(JSON.stringify(stored)).not.toContain('4242');
      // The status page: waiting, then done, and 404 for a code nobody was given. It shows nothing of any org.
      const waiting = await app.request(`/api/ads/meta/data-deletion?code=${body.confirmation_code}`);
      expect(waiting.status).toBe(200);
      expect(waiting.headers.get('cache-control')).toBe('no-store');
      expect(await waiting.text()).toContain('đang được xử lý');
      expect((await app.request(`/api/ads/meta/data-deletion?code=${'0'.repeat(32)}`)).status).toBe(404);
      expect((await app.request('/api/ads/meta/data-deletion?code=zzz')).status).toBe(404);
      expect((await app.request('/api/ads/meta/data-deletion')).status).toBe(404);
      // Nothing is linked to that user: the worker completes it with no account.
      expect(await runAdsDeletions({ runtime: worker, workerDb })).toBeGreaterThanOrEqual(1);
      const done = await adsDeletionStatus(api, body.confirmation_code);
      expect(done).toMatchObject({ accounts: 0 });
      expect(done?.completedAt).toBeInstanceOf(Date);
      expect(await (await app.request(`/api/ads/meta/data-deletion?code=${body.confirmation_code}`)).text()).toContain('không còn tài khoản quảng cáo nào');
    });

    it('answers a replay of a request that is still open with its own code, not a new row, and is told 503 when the table is full', async () => {
      const post = (body: string) => app.request('/api/ads/meta/data-deletion', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
      const first = (await (await post(form(signed('9191')))).json()) as { confirmation_code: string };
      const replay = (await (await post(form(signed('9191')))).json()) as { confirmation_code: string };
      expect(replay.confirmation_code).toBe(first.confirmation_code);
      expect(await row(`SELECT 1 FROM crove_ads.deletion_request WHERE user_hash = $1`, [platformUserHash(SECRET_META, '9191')])).toHaveLength(1);
      // The table's own limit is the database's answer (53400), which the runtime calls OVERLOADED: the callback says 503.
      const full = { orgless: async () => Promise.reject(new DomainError('OVERLOADED', 503, 'full')) } as unknown as Runtime;
      expect(await acceptAdsDeletion(full, SECRET_META, form(signed('9292')))).toEqual({ status: 503, code: 'DELETION_BACKLOG' });
      // Another failure of the database is not turned into an answer.
      const broken = { orgless: async () => Promise.reject(new Error('boom')) } as unknown as Runtime;
      await expect(acceptAdsDeletion(broken, SECRET_META, form(signed('9393')))).rejects.toThrow('boom');
    });

    it('drops the person who granted an account when a link says the platform did not name them, and keeps it when the link says nothing', async () => {
      const made = await linkedAs(orgId, asOwner(), 'Đổi người cấp quyền', '8080');
      const hashOf = async () => (await row<{ h: string | null }>(`SELECT granted_by_hash AS h FROM crove_ads.ad_account WHERE org_id = $1 AND id = $2`, [orgId, made.adAccountId]))[0]?.h;
      expect(await hashOf()).toBe(platformUserHash(SECRET_META, '8080'));
      // A link that says nothing of it (a retry, the sandbox) leaves it.
      await api.execute('ads.account.link', { connectionId: made.connectionId }, { actor: asOwner(), orgId });
      expect(await hashOf()).toBe(platformUserHash(SECRET_META, '8080'));
      // Another person grants it: their hash replaces the first, so the first one's request no longer reaches it.
      await api.execute('ads.account.link', { connectionId: made.connectionId, grantedByHash: platformUserHash(SECRET_META, '8081') }, { actor: asOwner(), orgId });
      expect(await hashOf()).toBe(platformUserHash(SECRET_META, '8081'));
      // The platform named nobody this time: nobody is named, not the person before.
      await api.execute('ads.account.link', { connectionId: made.connectionId, grantedByHash: null }, { actor: asOwner(), orgId });
      expect(await hashOf()).toBeNull();
    });

    it('refuses a body past the cap before reading it, and a client address past its rate, and stores nothing of either', async () => {
      const limited = createHttpApp({
        config: appConfig,
        runtime: api,
        store: new MemoryStore(),
        authenticate: createAuthenticator(appConfig, appDb),
        pool,
        aiEnabled: false,
        channels: { broker: vault, sandbox: true, adsPlatforms: sandbox, connectors: {}, publicUrl: 'https://ludy.example.test' },
        adsDeletion: { appSecret: SECRET_META },
        adsDeletionLimit: new RateLimiter({ perMinute: 3 }),
      });
      const post = (body: string) => limited.request('/api/ads/meta/data-deletion', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
      const before = await row<{ n: string }>(`SELECT count(*)::text AS n FROM crove_ads.deletion_request`);
      // A body past 8 KiB is refused whatever it holds, before it is read (so it does not use up the address's calls).
      const big = await post(`signed_request=${'a'.repeat(9 * 1024)}`);
      expect(big.status).toBe(413);
      // Three calls a minute from one address: the fourth is refused, with the time to wait, and still stores nothing.
      for (let i = 0; i < 3; i++) expect((await post('other=1')).status).toBe(400);
      const refused = await post(form(signed('4242')));
      expect(refused.status).toBe(429);
      expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
      expect(await row(`SELECT count(*)::text AS n FROM crove_ads.deletion_request`)).toEqual(before);
      // The status page shares the limit: it too answers 429 once the address has used it.
      expect((await limited.request(`/api/ads/meta/data-deletion?code=${'0'.repeat(32)}`)).status).toBe(429);
    });

    it('erases the ad accounts a deletion request names in every org, closes their connections, and leaves other people’s alone', async () => {
      // One person granted two accounts of this org and one of another org; another person granted one here.
      const mine1 = await linkedAs(orgId, asOwner(), 'Của người xin xóa 1', '5150');
      const mine2 = await linkedAs(orgId, asOwner(), 'Của người xin xóa 2', '5150');
      const theirs = await linkedAs(otherOrgId, outsiderActor(), 'Ở tổ chức khác', '5150');
      const stays = await linkedAs(orgId, asOwner(), 'Của người khác', '5151');
      for (const made of [mine1, mine2, stays]) await sync(made.connectionId);
      await sync(theirs.connectionId, sandbox, otherOrgId);
      expect((await daysOf(mine1.adAccountId)).length).toBeGreaterThan(300);
      const accepted = await acceptAdsDeletion(api, SECRET_META, form(signed('5150')));
      expect(accepted.status).toBe(200);
      const code = (accepted as { code: string }).code;
      expect(await runAdsDeletions({ runtime: worker, workerDb })).toBeGreaterThanOrEqual(1);
      // Everything of the three accounts is gone, in both orgs; the other person's is not.
      for (const [made, org] of [[mine1, orgId], [mine2, orgId], [theirs, otherOrgId]] as const) {
        expect(await row(`SELECT 1 FROM crove_ads.ad_account WHERE org_id = $1 AND id = $2`, [org, made.adAccountId])).toEqual([]);
        expect(await row(`SELECT 1 FROM crove_ads.ad_spend_day WHERE org_id = $1 AND ad_account_id = $2`, [org, made.adAccountId])).toEqual([]);
        expect(await row(`SELECT 1 FROM crove_ads.ad_sync_run WHERE org_id = $1 AND ad_account_id = $2`, [org, made.adAccountId])).toEqual([]);
        // The connection is closed and its token forgotten.
        // Closed, with the account's name and the token's permissions gone too: a platform id and the time it closed remain.
        expect(await row(`SELECT status, status_reason, display_name, scopes FROM crove_kernel.channel_connection WHERE org_id = $1 AND id = $2`, [org, made.connectionId])).toEqual([
          { status: 'revoked', status_reason: 'platform_deletion', display_name: 'Deleted', scopes: [] },
        ]);
        expect(await row(`SELECT 1 FROM crove_kernel.credential WHERE org_id = $1 AND connection_id = $2`, [org, made.connectionId])).toEqual([]);
      }
      expect((await daysOf(stays.adAccountId)).length).toBeGreaterThan(300);
      expect(await view(owner, stays.adAccountId)).toMatchObject({ connectionStatus: 'active' });
      expect(await adsDeletionStatus(api, code)).toMatchObject({ accounts: 3 });
      // The audit rows name the accounts and the counts, nothing of the person.
      const audit = await row<{ detail: Record<string, unknown> }>(`SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'ads.account.erase' AND outcome = 'ok'`, [orgId]);
      // (The platform's erase of an account in the write connection's own test is one more audit row of the same command.)
      expect(audit.length - eraseAuditsBefore).toBe(2);
      expect(JSON.stringify(audit)).not.toMatch(/5150|granted_by/);
      // Run again: nothing is waiting, nothing changes.
      expect(await runAdsDeletions({ runtime: worker, workerDb })).toBe(0);
    });

    it('lets only the API login enqueue and read a status, only the worker claim and complete, and no tenant role read the table', async () => {
      const code = randomBytes(16).toString('hex');
      const hash = platformUserHash(SECRET_META, '6060');
      await pool.query('SELECT crove_ads.deletion_request_enqueue($1, $2)', [code, hash]);
      expect((await pool.query('SELECT * FROM crove_ads.deletion_request_status($1)', [code])).rows).toHaveLength(1);
      await expect(pool.query('SELECT * FROM crove_ads.deletion_request_claim(10)')).rejects.toMatchObject({ code: '42501' });
      await expect(pool.query('SELECT crove_ads.deletion_request_complete($1, 0)', [code])).rejects.toMatchObject({ code: '42501' });
      await expect(pool.query('SELECT * FROM crove_ads.deletion_request')).rejects.toMatchObject({ code: '42501' });
      const workerPool = workerPools[0] as pg.Pool;
      await expect(workerPool.query('SELECT crove_ads.deletion_request_enqueue($1, $2)', [randomBytes(16).toString('hex'), hash])).rejects.toMatchObject({ code: '42501' });
      await expect(workerPool.query('SELECT * FROM crove_ads.deletion_request_status($1)', [code])).rejects.toMatchObject({ code: '42501' });
      expect((await workerPool.query('SELECT * FROM crove_ads.deletion_request_claim(1000)')).rows.some((r: { code: string }) => r.code === code)).toBe(true);
      // A request that failed is put off, by the worker alone, and is not claimed again until its time.
      await expect(pool.query('SELECT crove_ads.deletion_request_defer($1)', [code])).rejects.toMatchObject({ code: '42501' });
      await workerPool.query('SELECT crove_ads.deletion_request_defer($1)', [code]);
      expect((await workerPool.query('SELECT * FROM crove_ads.deletion_request_claim(1000)')).rows.some((r: { code: string }) => r.code === code)).toBe(false);
      // A bad code or hash is refused; the same person asking again gets the open request's code, and no new row.
      await expect(pool.query('SELECT crove_ads.deletion_request_enqueue($1, $2)', ['nope', hash])).rejects.toMatchObject({ code: '22P02' });
      expect((await pool.query('SELECT crove_ads.deletion_request_enqueue($1, $2) AS code', [randomBytes(16).toString('hex'), hash])).rows[0]?.code).toBe(code);
      // The history definer needs a context of an org: the API login alone gets none.
      await expect(pool.query('SELECT * FROM crove_ads.account_history_delete($1::uuid, false, NULL)', [randomUUID()])).rejects.toMatchObject({ code: '42501' });
    });
  });

  // Meta (#2218): the OAuth grant connects each ad account and links it, the real adapter reads recorded Graph answers, a
  // rate limit holds the account back, an expired token expires the connection, and connecting again resumes it with no day lost.
  describe('Meta ad accounts', () => {
    const meta = { appSecret: 'meta-app-secret', graphVersion: 'v24.0' } as const;
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    // Graph as Meta answers it for two ad accounts in dong: the same shape for any window asked.
    // Every request the adapter makes, to show that none is a write.
    const methods: string[] = [];
    const graph = (mode: 'ok' | 'limited' | 'expired' = 'ok'): Fetch => async (input, init) => {
      methods.push(init?.method ?? 'GET');
      const url = new URL(input);
      if (mode === 'expired') return json(400, { error: { code: 190, message: 'Error validating access token: Session has expired' } });
      if (mode === 'limited') return json(400, { error: { code: 80004, message: 'There have been too many calls from this ad-account' } });
      if (url.pathname.endsWith('/me/adaccounts')) {
        return json(200, { data: ['act_9001', 'act_9002'].map((id) => ({ id, name: `Meta ${id}`, currency: 'VND', timezone_name: 'Asia/Ho_Chi_Minh' })) });
      }
      const { since, until } = JSON.parse(url.searchParams.get('time_range') ?? '{}') as { since: string; until: string };
      const level = url.searchParams.get('level');
      const data: unknown[] = [];
      for (let ms = Date.parse(`${since}T00:00:00Z`); ms <= Date.parse(`${until}T00:00:00Z`); ms += DAY_MS) {
        const day = new Date(ms).toISOString().slice(0, 10);
        if (level === 'account') data.push({ date_start: day, spend: '100000', impressions: '1000', clicks: '50', reach: '800', actions: [{ action_type: 'omni_purchase', value: '2' }] });
        else for (const [id, spend] of [['2301', '60000'], ['2302', '40000']] as const) data.push({ date_start: day, campaign_id: id, campaign_name: `Chiến dịch ${id}`, spend, impressions: '500', clicks: '25', actions: [{ action_type: 'omni_purchase', value: '1' }] });
      }
      return json(200, { data });
    };
    const read = (mode: 'ok' | 'limited' | 'expired') => ({ meta_ads: new MetaAdsPlatform({ ...meta, now: clock, fetch: graph(mode) }) }) as Readonly<Record<string, AdPlatform>>;
    const metaRpc = async (path: string, who: Account, input: unknown) => rpc(path, await tokenFor(who), input);
    const grant = async (who: Account) => {
      const started = await metaRpc('channels/oauthStart', who, { provider: 'meta_ads' });
      if (started.status !== 200) return { started, finished: null };
      const finished = await metaRpc('channels/oauthFinish', who, { provider: 'meta_ads', state: started.body.state, code: 'the-code' });
      return { started, finished };
    };

    it('connects every ad account of a grant and links it to the books, for an owner or admin only, once per attempt', async () => {
      expect((await grant(member)).started.status).toBe(403);
      expect((await grant(viewer)).started.status).toBe(403);
      const { started, finished } = await grant(owner);
      // The dialog is Meta's, asked for ads_read, and comes back to the one callback address of the deployment.
      expect(started.body.authorizeUrl).toContain('scope=ads_read');
      expect(decodeURIComponent(started.body.authorizeUrl)).toContain('https://ludy.example.test/channels/oauth/meta_ads/callback');
      expect(finished?.status, JSON.stringify(finished?.body)).toBe(200);
      expect(finished?.body.connections.map((c: { displayName: string }) => c.displayName).sort()).toEqual(['Meta act_9001', 'Meta act_9002']);
      expect(finished?.body.failed).toEqual([]);
      // The answer of the grant carries no token.
      expect(JSON.stringify(finished?.body)).not.toContain('EAAB-grant-token');
      const listed = (await ok('ads/accounts', owner, undefined)) as AdAccountView[];
      const mine = listed.filter((a) => a.provider === 'meta_ads').sort((a, b) => a.name.localeCompare(b.name));
      expect(mine.map((a) => [a.name, a.connectionStatus, a.resultKinds])).toEqual([
        ['Meta act_9001', 'active', ['purchase', 'lead', 'message']],
        ['Meta act_9002', 'active', ['purchase', 'lead', 'message']],
      ]);
      // A permission beyond ads_read (a Pages one) is accepted and shown; the other account holds none.
      expect(mine.map((a) => a.extraScopes)).toEqual([[], ['pages_manage_posts']]);
      // The person who granted them is kept as a keyed hash only (#2219), never as the id Meta gave: Meta's data deletion
      // request finds their accounts by it.
      const grantedBy = await row<{ granted_by_hash: string }>(`SELECT granted_by_hash FROM crove_ads.ad_account WHERE org_id = $1 AND provider = 'meta_ads' ORDER BY external_account_id`, [orgId]);
      expect(grantedBy.map((r) => r.granted_by_hash)).toEqual([platformUserHash('meta-app-secret', META_GRANT.user), platformUserHash('meta-app-secret', META_GRANT.user)]);
      expect(JSON.stringify(grantedBy)).not.toContain(META_GRANT.user);
      // Sealed once per connection and in no answer, audit row or event; the first sync was queued by the link.
      const sealed = await row<{ n: string }>(`SELECT count(*)::text AS n FROM crove_kernel.credential c JOIN crove_kernel.channel_connection k ON k.org_id = c.org_id AND k.id = c.connection_id WHERE c.org_id = $1 AND k.provider = 'meta_ads'`, [orgId]);
      expect(sealed[0]?.n).toBe('2');
      const leaks = await row<{ n: string }>(
        `SELECT (SELECT count(*) FROM crove_kernel.audit_event WHERE org_id = $1 AND detail::text LIKE '%EAAB-grant-token%') + (SELECT count(*) FROM crove_kernel.outbox_event WHERE org_id = $1 AND payload::text LIKE '%EAAB-grant-token%') AS n`,
        [orgId],
      );
      expect(leaks[0]?.n).toBe('0');
      const linked = await row<{ n: string }>(`SELECT count(*)::text AS n FROM crove_kernel.outbox_event WHERE org_id = $1 AND type = 'ads.account.linked' AND payload->>'ad_account_id' = ANY ($2)`, [orgId, mine.map((a) => a.id)]);
      expect(linked[0]?.n).toBe('2');
      // The attempt is single use.
      const again = await metaRpc('channels/oauthFinish', owner, { provider: 'meta_ads', state: started.body.state, code: 'the-code' });
      expect(again.status).toBeGreaterThanOrEqual(400);
      // Social's channel list does not show them.
      const channels = (await ok('channels/list', owner, {})) as Array<{ provider: string }>;
      expect(channels.some((c) => c.provider === 'meta_ads')).toBe(false);
    });

    // SQL as the signed-in owner (the switches are the owner's), committed.
    const ownerSql = (text: string, params: unknown[]) =>
      (async () => {
        const c = await pool.connect();
        try {
          await c.query('BEGIN');
          const token = mintContextToken(process.env.CROVE_CONTEXT_TOKEN_KEY ?? '', { userId: owner.userId, orgId, sessionId: null, aal: 'aal1', mfaAt: null });
          await c.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [orgId, token]);
          await c.query('INSERT INTO crove_ads.ad_org_setting (org_id) VALUES ($1) ON CONFLICT DO NOTHING', [orgId]);
          await c.query(text, params);
          await c.query('COMMIT');
        } finally {
          await c.query('ROLLBACK').catch(() => undefined);
          c.release();
        }
      })();
    const switchOn = () => ownerSql('UPDATE crove_ads.ad_org_setting SET write_enabled = true, launches_blocked = false WHERE org_id = $1', [orgId]);
    const switchOff = () => ownerSql('UPDATE crove_ads.ad_org_setting SET write_enabled = false, launches_blocked = false WHERE org_id = $1', [orgId]);
    const readStatus = async (provider: string) =>
      row<{ id: string; external_account_id: string; status: string; status_reason: string | null; scopes: string[]; sealed: string }>(
        `SELECT k.id, k.external_account_id, k.status, k.status_reason, k.scopes, (SELECT count(*)::text FROM crove_kernel.credential c WHERE c.org_id = k.org_id AND c.connection_id = k.id) AS sealed
           FROM crove_kernel.channel_connection k WHERE k.org_id = $1 AND k.provider = $2 ORDER BY k.external_account_id, k.connected_at, k.id`,
        [orgId, provider],
      );
    // A closed connection is not opened again: the next sign-in makes a new one for the platform account, and the ad account follows it.
    const openReading = async () => (await readStatus('meta_ads')).filter((r) => r.status !== 'revoked');
    // A reading connection of the given platform account, made as the sign-in makes it (sealed), with the scopes and grantor given; `link()` links
    // it as the sign-in does. Made again with the same key, it is the same connection with the new scopes (a person signing in again).
    const readingConnection = async (externalAccountId: string, scopes: string[], grantor: string | null, provider: 'meta_ads' | 'sandbox_ads' = 'meta_ads') => {
      const sealedToken = vault.seal(JSON.stringify({ accessToken: 'EAAB-other-token' }), { orgId, provider, externalAccountId });
      const made = await api.execute<{ connectionId: string }>(
        'kernel.channel.connect',
        { provider, externalAccountId, displayName: `Meta ${externalAccountId}`, scopes, expiresAt: null, credential: { keyId: sealedToken.keyId, envelope: sealedToken.envelope.toString('base64') } },
        { actor: asOwner(), orgId },
      );
      return {
        connectionId: made.connectionId,
        link: () => api.execute<{ adAccountId: string | null; linked: boolean; refused?: string }>('ads.account.link', { connectionId: made.connectionId, ...(grantor ? { grantedByHash: platformUserHash('meta-app-secret', grantor) } : {}) }, { actor: asOwner(), orgId }),
      };
    };
    const adAccountOf = async (externalAccountId: string) => (await row<{ id: string }>(`SELECT id FROM crove_ads.ad_account WHERE org_id = $1 AND external_account_id = $2`, [orgId, externalAccountId]))[0]?.id as string;
    const attachedWrite = async (adAccountId: string) => (await row<{ id: string | null }>(`SELECT write_connection_id AS id FROM crove_ads.ad_account WHERE org_id = $1 AND id = $2`, [orgId, adAccountId]))[0]?.id ?? null;
    const statusOf = async (connectionId: string, provider = 'meta_ads') => (await readStatus(provider)).find((r) => r.id === connectionId);

    it('connects the write connection of a Meta grant for the owner alone, while the switch is on, and only to accounts linked for reading', async () => {
      const writeGrant = async (who: Account) => {
        const started = await metaRpc('channels/oauthStart', who, { provider: 'metawrite_ads' });
        if (started.status !== 200) return { started, finished: null };
        return { started, finished: await metaRpc('channels/oauthFinish', who, { provider: 'metawrite_ads', state: started.body.state, code: 'the-code' }) };
      };
      // The read grant of the test before made the two accounts (the write connection hangs off them); the switch on now.
      await ownerSql('UPDATE crove_ads.ad_org_setting SET write_enabled = false, launches_blocked = false WHERE org_id = $1', [orgId]);
      expect((await writeGrant(owner)).started).toMatchObject({ status: 409, body: { code: 'ADS_WRITE_OFF' } });
      await ownerSql('UPDATE crove_ads.ad_org_setting SET write_enabled = true WHERE org_id = $1', [orgId]);
      // The owner's alone: an admin, a member and a viewer are refused before the dialog.
      for (const who of [adminAccount, member, viewer]) expect((await writeGrant(who)).started.status, who.email).toBe(403);
      const { started, finished } = await writeGrant(owner);
      expect(started.body.authorizeUrl).toContain('scope=ads_read,ads_management');
      expect(decodeURIComponent(started.body.authorizeUrl)).toContain('https://ludy.example.test/channels/oauth/metawrite_ads/callback');
      expect(finished?.status, JSON.stringify(finished?.body)).toBe(200);
      expect(finished?.body.failed).toEqual([]);
      expect(JSON.stringify(finished?.body)).not.toContain('EAAB-write-token');
      const listed = ((await ok('ads/accounts', owner, undefined)) as AdAccountView[]).filter((a) => a.provider === 'meta_ads');
      // Two accounts, each read only before and able to run ads now, the read connection's own permissions unchanged.
      expect(listed.map((a) => [a.name, a.canRunAds, a.writeConnectionStatus])).toEqual([
        ['Meta act_9001', true, 'active'],
        ['Meta act_9002', true, 'active'],
      ]);
      expect(listed.map((a) => a.extraScopes)).toEqual([[], ['pages_manage_posts']]);
      expect(listed).toHaveLength(2);
      const hashes = await row<{ h: string | null; g: string | null }>(`SELECT write_granted_by_hash AS h, granted_by_hash AS g FROM crove_ads.ad_account WHERE org_id = $1 AND provider = 'meta_ads' ORDER BY external_account_id`, [orgId]);
      // The same person granted both: with one app the two hashes are equal, and neither is Meta's id.
      expect(hashes.map((r) => r.h)).toEqual([platformUserHash('meta-app-secret', META_GRANT.user), platformUserHash('meta-app-secret', META_GRANT.user)]);
      expect(hashes.map((r) => r.h)).toEqual(hashes.map((r) => r.g));
      expect(JSON.stringify(hashes)).not.toContain(META_GRANT.user);
      const sealedWrite = await row<{ n: string }>(`SELECT count(*)::text AS n FROM crove_kernel.credential c JOIN crove_kernel.channel_connection k ON k.org_id = c.org_id AND k.id = c.connection_id WHERE c.org_id = $1 AND k.provider = 'metawrite_ads'`, [orgId]);
      expect(sealedWrite[0]?.n).toBe('2');
      // Reading connections of the org that are not the person's: another person's, one whose grantor Meta did not name, one made and never
      // linked, and a sandbox one (no platform holds a permission for it).
      const other = await readingConnection('act_9100', ['ads_read'], '7002');
      await other.link();
      const unknown = await readingConnection('act_9101', ['ads_read'], null);
      await unknown.link();
      const loose = await readingConnection('act_9102', ['ads_read'], null);
      const box = await readingConnection('sbxads-clean', [], null, 'sandbox_ads');
      await box.link();
      // Switching writing off closes both write connections and drops their tokens. The reading connections of the platform close too: with
      // the one Meta app, a permission belongs to the app and the person, so the person's read tokens (recorded as ads_read only) can change
      // campaigns as well, and who the person is cannot be told for sure (another one, none named, never linked): the close fails safe.
      const off = await metaRpc('ads/writeDisable', owner, { idempotencyKey: randomUUID() });
      // Every write connection of the org, these two and any the tests before left open.
      expect(off.status).toBe(200);
      expect(off.body.connectionsClosed).toBeGreaterThanOrEqual(2);
      expect(off.body.readConnectionsClosed).toBe(5);
      const after = await row<{ n: string }>(`SELECT count(*)::text AS n FROM crove_kernel.credential c JOIN crove_kernel.channel_connection k ON k.org_id = c.org_id AND k.id = c.connection_id WHERE c.org_id = $1 AND k.provider IN ('metawrite_ads')`, [orgId]);
      expect(after[0]?.n).toBe('0');
      expect(await openReading()).toEqual([]);
      for (const id of [other.connectionId, unknown.connectionId, loose.connectionId]) expect(await statusOf(id), id).toMatchObject({ status: 'revoked', status_reason: 'spend_scopes', scopes: ['ads_read'], sealed: '0' });
      expect((await readStatus('meta_ads')).filter((r) => r.status === 'revoked').map((r) => [r.external_account_id, r.status_reason, r.scopes, r.sealed]).slice(0, 2)).toEqual([
        ['act_9001', 'spend_scopes', ['ads_read'], '0'],
        ['act_9002', 'spend_scopes', ['ads_read', 'pages_manage_posts'], '0'],
      ]);
      // The offline sandbox holds no permission anywhere: its reading connection stays.
      expect(await statusOf(box.connectionId, 'sandbox_ads')).toMatchObject({ status: 'active', sealed: '1' });
      // The screen says why and asks for a read-only reconnect; nothing else of the account is lost.
      expect(await view(owner, await adAccountOf('act_9001'))).toMatchObject({ connectionStatus: 'revoked', pausedReason: 'spend_scopes', canRunAds: false });
      // Switched off again: the person removed the app in Facebook, the login returns a token that holds ads_read only, and reading connects again.
      expect((await grant(owner)).finished?.status).toBe(200);
      expect((await openReading()).map((r) => [r.external_account_id, r.sealed])).toEqual([['act_9001', '1'], ['act_9002', '1']]);
      // The account is the same one, on the new connection: its history and settings stay.
      expect(await view(owner, await adAccountOf('act_9001'))).toMatchObject({ connectionStatus: 'active', pausedReason: null });
    });

    it('accepts a reading token that can change campaigns only from an owner while the switch is on, closes a link refused after a switch-off, and closes by scopes and by the memory of a write connection', async () => {
      const countReading = async () => (await row<{ n: string }>(`SELECT count(*)::text AS n FROM crove_kernel.channel_connection WHERE org_id = $1 AND provider = 'meta_ads'`, [orgId]))[0]?.n;
      // The person's token holds ads_management (they granted it to the shared app before). Off: refused as before, nothing connected.
      await switchOff();
      META_GRANT.write = true;
      try {
        const before = await countReading();
        const refused = (await grant(owner)).finished;
        expect(refused).toMatchObject({ status: 422, body: { code: 'OAUTH_WRITE_PERMISSION' } });
        expect(META_GRANT.lastSpendAllowed).toBe(false);
        expect(await countReading()).toBe(before);
        // On: an admin is still refused (an admin who edits the dialog to ask for more must not seal a token that can spend), an owner is
        // accepted, the permission recorded, and the screen shows it among what the token can also do.
        await switchOn();
        const byAdmin = (await grant(adminAccount)).finished;
        expect(byAdmin).toMatchObject({ status: 422, body: { code: 'OAUTH_WRITE_PERMISSION' } });
        expect(META_GRANT.lastSpendAllowed).toBe(false);
        expect(await countReading()).toBe(before);
        const accepted = (await grant(owner)).finished;
        expect(accepted?.status, JSON.stringify(accepted?.body)).toBe(200);
        expect(META_GRANT.lastSpendAllowed).toBe(true);
        expect((await openReading()).map((r) => [r.external_account_id, r.scopes.includes('ads_management')])).toEqual([['act_9001', true], ['act_9002', true]]);
        const listed = ((await ok('ads/accounts', owner, undefined)) as AdAccountView[]).filter((a) => ['Meta act_9001', 'Meta act_9002'].includes(a.name));
        expect(listed).toHaveLength(2);
        expect(listed.every((a) => a.connectionStatus === 'active' && a.extraScopes.includes('ads_management'))).toBe(true);
      } finally {
        META_GRANT.write = false;
      }
      const spendCapable = (await openReading()).map((r) => r.id);
      expect(spendCapable).toHaveLength(2);
      // A person signing in again while running ads is switched off by somebody else: the connection is the same row, its token the new one
      // (spend scopes recorded), and the link, which follows, sees the switch off. The link closes the connection in its own transaction and
      // says so (a throw would roll the closing back), so the token does not stay linked.
      const racer = await readingConnection('act_9300', ['ads_read'], null);
      expect(await racer.link()).toMatchObject({ linked: true });
      const racing = await readingConnection('act_9300', ['ads_read', 'ads_management'], null);
      expect(racing.connectionId).toBe(racer.connectionId);
      await switchOff();
      expect(await racing.link()).toMatchObject({ adAccountId: null, linked: false, refused: 'spend_scopes' });
      expect(await statusOf(racer.connectionId)).toMatchObject({ status: 'revoked', status_reason: 'spend_scopes', sealed: '0' });
      expect(await view(owner, await adAccountOf('act_9300'))).toMatchObject({ connectionStatus: 'revoked', pausedReason: 'spend_scopes' });
      // By recorded scopes alone, whatever the platform: a reading connection of another platform that holds a spend permission and was
      // never linked is closed by the switch-off, and one that holds none is not.
      const sbxSpend = await readingConnection('sbxads-spend', ['ads_management'], null, 'sandbox_ads');
      const sbxClean = await readingConnection('sbxads-clean-two', [], null, 'sandbox_ads');
      // And by the memory that a write connection was made: its account lets go of it (a deletion request, as the system), the closed
      // write connection stays as the record, and a clean reading connection of the platform, linked while the switch is off, is closed too.
      for (const external of ['act_9001', 'act_9002']) await worker.execute('ads.account.forget_write', { adAccountId: await adAccountOf(external) }, { actor: SYSTEM, orgId });
      expect(await attachedWrite(await adAccountOf('act_9001'))).toBeNull();
      const clean = await readingConnection('act_9400', ['ads_read'], '7003');
      expect(await clean.link()).toMatchObject({ linked: true });
      const off = await metaRpc('ads/writeDisable', owner, { idempotencyKey: randomUUID() });
      expect(off.status).toBe(200);
      expect(off.body.readConnectionsClosed).toBe(4);
      for (const id of [...spendCapable, clean.connectionId]) expect(await statusOf(id), id).toMatchObject({ status: 'revoked', status_reason: 'spend_scopes', sealed: '0' });
      expect(await statusOf(sbxSpend.connectionId, 'sandbox_ads')).toMatchObject({ status: 'revoked', status_reason: 'spend_scopes', sealed: '0' });
      expect(await statusOf(sbxClean.connectionId, 'sandbox_ads')).toMatchObject({ status: 'active', sealed: '1' });
      expect(await openReading()).toEqual([]);
      // Reading connects again once the token holds ads_read only.
      expect((await grant(owner)).finished?.status).toBe(200);
      expect((await openReading()).map((r) => r.external_account_id)).toEqual(['act_9001', 'act_9002']);
      expect((await openReading()).every((r) => !r.scopes.includes('ads_management'))).toBe(true);
    });

    it('closes the Meta reading connections when running ads is switched off from on, whether or not a consent at Meta ever reached Ludy', async () => {
      // A second org that has never made a write connection: no write connection row is the evidence here, only that the switch was on.
      const token = await tokenFor(outsider);
      const asOutsider = { type: 'user' as const, userId: outsider.userId, aal: 'aal1' as const, sessionId: outsider.session };
      const settingSql = (text: string) =>
        (async () => {
          const c = await pool.connect();
          try {
            await c.query('BEGIN');
            const ctxToken = mintContextToken(process.env.CROVE_CONTEXT_TOKEN_KEY ?? '', { userId: outsider.userId, orgId: otherOrgId, sessionId: null, aal: 'aal1', mfaAt: null });
            await c.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [otherOrgId, ctxToken]);
            await c.query('INSERT INTO crove_ads.ad_org_setting (org_id) VALUES ($1) ON CONFLICT DO NOTHING', [otherOrgId]);
            await c.query(text, [otherOrgId]);
            await c.query('COMMIT');
          } finally {
            await c.query('ROLLBACK').catch(() => undefined);
            c.release();
          }
        })();
      const reading = async (externalAccountId: string, grantor: string | null, scopes: string[] = ['ads_read']) => {
        const sealedToken = vault.seal(JSON.stringify({ accessToken: 'EAAB-second-org-token' }), { orgId: otherOrgId, provider: 'meta_ads', externalAccountId });
        const made = await api.execute<{ connectionId: string }>(
          'kernel.channel.connect',
          { provider: 'meta_ads', externalAccountId, displayName: `Meta ${externalAccountId}`, scopes, expiresAt: null, credential: { keyId: sealedToken.keyId, envelope: sealedToken.envelope.toString('base64') } },
          { actor: asOutsider, orgId: otherOrgId },
        );
        await api.execute('ads.account.link', { connectionId: made.connectionId, ...(grantor ? { grantedByHash: platformUserHash('meta-app-secret', grantor) } : {}) }, { actor: asOutsider, orgId: otherOrgId });
        return made.connectionId;
      };
      const ids = [await reading('act_9501', '7001'), await reading('act_9502', null)];
      expect((await row<{ n: string }>(`SELECT count(*)::text AS n FROM crove_kernel.channel_connection WHERE org_id = $1 AND provider = 'metawrite_ads'`, [otherOrgId]))[0]?.n).toBe('0');
      // The owner turns running ads on and starts the dialog for the connection that can run ads: the person consents at Meta (or means to).
      await settingSql('UPDATE crove_ads.ad_org_setting SET write_enabled = true, launches_blocked = false WHERE org_id = $1');
      const started = await rpc('channels/oauthStart', token, { provider: 'metawrite_ads' }, otherSlug);
      expect(started.status, JSON.stringify(started.body)).toBe(200);
      // Running ads is switched off before the callback comes back: the callback is refused and nothing of the consent reaches Ludy, yet
      // the consent at Meta makes every token of that person for the app able to change campaigns, the reading ones included.
      const off = await rpc('ads/writeDisable', token, { idempotencyKey: randomUUID() }, otherSlug);
      expect(off.status, JSON.stringify(off.body)).toBe(200);
      expect(off.body.readConnectionsClosed).toBe(2);
      const callback = await rpc('channels/oauthFinish', token, { provider: 'metawrite_ads', state: started.body.state, code: 'the-code' }, otherSlug);
      expect(callback).toMatchObject({ status: 409, body: { code: 'ADS_WRITE_OFF' } });
      const left = await row<{ id: string; status: string; status_reason: string | null; sealed: string }>(
        `SELECT k.id, k.status, k.status_reason, (SELECT count(*)::text FROM crove_kernel.credential c WHERE c.org_id = k.org_id AND c.connection_id = k.id) AS sealed
           FROM crove_kernel.channel_connection k WHERE k.org_id = $1 AND k.provider = 'meta_ads' ORDER BY k.external_account_id`,
        [otherOrgId],
      );
      expect(left).toEqual(ids.map((id) => ({ id, status: 'revoked', status_reason: 'spend_scopes', sealed: '0' })));
      // The switch was already off: a second switch-off, with nothing new, closes nothing more and fails nothing.
      expect((await rpc('ads/writeDisable', token, { idempotencyKey: randomUUID() }, otherSlug)).body.readConnectionsClosed).toBe(0);
      // With a write app of its own (the API says `sharedApp: false`, from its config) no reading token can hold the permission: a clean
      // reading connection stays open when running ads is switched off, and one whose recorded scopes hold the permission still closes.
      await settingSql('UPDATE crove_ads.ad_org_setting SET write_enabled = true, launches_blocked = false WHERE org_id = $1');
      const clean = await reading('act_9503', '7001');
      const recorded = await reading('act_9504', null, ['ads_read', 'ads_management']);
      const own = await api.execute<{ readConnectionsClosed: number }>('ads.write.disable', { sharedApp: false }, { actor: asOutsider, orgId: otherOrgId });
      expect(own.readConnectionsClosed).toBe(1);
      const state = async (id: string) => (await row<{ status: string }>(`SELECT status FROM crove_kernel.channel_connection WHERE org_id = $1 AND id = $2`, [otherOrgId, id]))[0]?.status;
      expect(await state(clean)).toBe('active');
      expect(await state(recorded)).toBe('revoked');
      // Said nothing, it fails safe: the clean one closes too.
      await settingSql('UPDATE crove_ads.ad_org_setting SET write_enabled = true, launches_blocked = false WHERE org_id = $1');
      const safe = await api.execute<{ readConnectionsClosed: number }>('ads.write.disable', {}, { actor: asOutsider, orgId: otherOrgId });
      expect(safe.readConnectionsClosed).toBe(1);
      expect(await state(clean)).toBe('revoked');
    });

    it('reads 13 months in the adapter\'s windows with only GET requests, and stores them in the account\'s currency and time zone', async () => {
      const at = freeze();
      const listed = (await ok('ads/accounts', owner, undefined)) as AdAccountView[];
      const account = listed.find((a) => a.name === 'Meta act_9001') as AdAccountView;
      const result = await sync(account.connectionId, read('ok'));
      expect(result.rows).toBeGreaterThan(300 * 3);
      const after = ((await ok('ads/accounts', owner, undefined)) as AdAccountView[]).find((a) => a.id === account.id);
      expect(after).toMatchObject({ currency: 'VND', timeZone: 'Asia/Ho_Chi_Minh', lastErrorKind: null });
      // Meta restates its latest 28 days: the newest day is not final, one older than that is.
      expect(after?.settledThrough).toBe(new Date(Date.parse(todayIn('Asia/Ho_Chi_Minh', at)) - 29 * DAY_MS).toISOString().slice(0, 10));
      const today = todayIn('Asia/Ho_Chi_Minh', at);
      // The owner picks the action that counts as a result; Meta's omni_purchase is the "purchase" of this adapter.
      await ok('ads/configure', owner, { adAccountId: account.id, resultKind: 'purchase', idempotencyKey: randomUUID() });
      const summary = (await ok('ads/summary', owner, { adAccountId: account.id, from: new Date(Date.parse(today) - 6 * DAY_MS).toISOString().slice(0, 10), to: today })) as AdsSummary;
      expect(summary.total.spend).toBe('700000');
      expect(summary.total.results).toBe('14');
      expect(summary.campaigns.map((c) => c.name).sort()).toEqual(['Chiến dịch 2301', 'Chiến dịch 2302']);
      // Everything the sync asked Meta was a read.
      expect(methods.length).toBeGreaterThan(20);
      expect(new Set(methods)).toEqual(new Set(['GET']));
    });

    it('holds an account back after a rate limit, expires it on a refused token, and resumes it when connected again, with no day lost', async () => {
      const listed = (await ok('ads/accounts', owner, undefined)) as AdAccountView[];
      const account = listed.find((a) => a.name === 'Meta act_9002') as AdAccountView;
      // Nothing read yet for this account: a rate limit leaves its cursors alone and names when to try again.
      await sync(account.connectionId, read('limited'));
      let view2 = ((await ok('ads/accounts', owner, undefined)) as AdAccountView[]).find((a) => a.id === account.id) as AdAccountView;
      expect(view2).toMatchObject({ lastErrorKind: 'rate_limited', syncedThrough: null, settledThrough: null, connectionStatus: 'active' });
      expect(Date.parse(view2.nextRunAt as string)).toBeGreaterThan(Date.now() + 50 * 60_000);
      // A refused token ends the connection, kept as it is.
      await row(`UPDATE crove_ads.ad_account SET next_run_at = NULL WHERE org_id = $1 AND id = $2`, [orgId, account.id]);
      await sync(account.connectionId, read('expired'));
      view2 = ((await ok('ads/accounts', owner, undefined)) as AdAccountView[]).find((a) => a.id === account.id) as AdAccountView;
      expect(view2).toMatchObject({ connectionStatus: 'expired', lastErrorKind: 'token_expired' });
      // Connecting again is the same connection and the same ad account, with its settings and history.
      const { finished } = await grant(owner);
      expect(finished?.status, JSON.stringify(finished?.body)).toBe(200);
      const back = ((await ok('ads/accounts', owner, undefined)) as AdAccountView[]).filter((a) => a.name === 'Meta act_9002');
      expect(back).toHaveLength(1);
      expect(back[0]).toMatchObject({ id: account.id, connectionId: account.connectionId, connectionStatus: 'active' });
      await row(`UPDATE crove_ads.ad_account SET next_run_at = NULL WHERE org_id = $1 AND id = $2`, [orgId, account.id]);
      const resumed = await sync(account.connectionId, read('ok'));
      expect(resumed.rows).toBeGreaterThan(300 * 3);
      const final = ((await ok('ads/accounts', owner, undefined)) as AdAccountView[]).find((a) => a.id === account.id);
      expect(final).toMatchObject({ lastErrorKind: null, connectionStatus: 'active' });
      expect(final?.settledThrough).not.toBeNull();
    });

    it('refuses a grant whose token can change ads, says why in its own words, and connects nothing', async () => {
      // While running ads is off: with it on the token is accepted (the test before).
      await switchOff();
      const before = await row<{ n: string }>(`SELECT count(*)::text AS n FROM crove_kernel.channel_connection WHERE org_id = $1 AND provider = 'meta_ads'`, [orgId]);
      META_GRANT.write = true;
      try {
        const { finished } = await grant(owner);
        expect(finished?.status).toBe(422);
        expect(finished?.body.code).toBe('OAUTH_WRITE_PERMISSION');
        expect(finished?.body.message).toContain('ads_management');
      } finally {
        META_GRANT.write = false;
      }
      const after = await row<{ n: string }>(`SELECT count(*)::text AS n FROM crove_kernel.channel_connection WHERE org_id = $1 AND provider = 'meta_ads'`, [orgId]);
      expect(after[0]?.n).toBe(before[0]?.n);
    });

    it('does not offer an ad platform where the Ads module is off, and refuses its OAuth then', async () => {
      const offApp = createHttpApp({
        config: appConfig,
        runtime: new Runtime(appDb, { manifests: TEST_MANIFESTS, absentModules: ['ads'] }).register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: null }) }),
        store: new MemoryStore(),
        authenticate: createAuthenticator(appConfig, appDb),
        pool,
        aiEnabled: false,
        channels: { broker: vault, sandbox: true, connectors: { meta_ads: META_CONNECTOR }, publicUrl: 'https://ludy.example.test' },
      });
      const response = await offApp.request('/api/rpc/channels/oauthStart', {
        method: 'POST',
        headers: { authorization: `Bearer ${await tokenFor(owner)}`, 'content-type': 'application/json', 'x-crove-org': slug },
        body: JSON.stringify({ json: { provider: 'meta_ads' } }),
      });
      expect(response.status).toBe(404);
    });
  });
});

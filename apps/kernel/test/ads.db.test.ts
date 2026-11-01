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
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AdPlatformError, MetaAdsPlatform, adPlatforms, platformUserHash, type AdPlatform, type sandboxAdPlatform } from '@crove/ad-platform';
import { ConnectorError, type Fetch, type OAuthConnector } from '@crove/channel';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { kernelCommands, kernelQueries } from '@crove/kernel';
import type { AdAccountView, AdsSummary, AdsSyncRunView } from '@crove/kernel-contract';
import { CredentialVault, DomainError, mintContextToken, parseVaultKey, Runtime, sha256Hex, type BlobStore } from '@crove/kernel-runtime';
import { addMonths, adsCommands, adsQueries, todayIn } from '@crove/mod-ads';
import { createAuthenticator } from '../src/auth.ts';
import { acceptAdsDeletion, adsDeletionStatus, runAdsDeletions } from '../src/ads-deletion.ts';
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
const META_GRANT = { write: false, user: '7001' };
const META_CONNECTOR: OAuthConnector = {
  provider: 'meta_ads',
  pkce: false,
  authorizeUrl: ({ state, redirectUri }) => `https://www.facebook.com/v24.0/dialog/oauth?state=${state}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=ads_read`,
  exchange: async () => {
    // The grant of a person whose token also holds ads_management: the connector refuses it, as MetaAdsConnector does.
    if (META_GRANT.write) throw new ConnectorError('denied', 'the token holds ads_management', 'WRITE_PERMISSION_GRANTED');
    // The second account's token also holds a Pages permission, which is accepted and shown.
    return ['act_9001', 'act_9002'].map((id) => ({
      provider: 'meta_ads' as const,
      externalAccountId: id,
      displayName: `Meta ${id}`,
      scopes: id === 'act_9002' ? ['ads_read', 'pages_manage_posts'] : ['ads_read'],
      expiresAt: new Date(Date.now() + 60 * DAY_MS),
      secret: JSON.stringify({ accessToken: 'EAAB-grant-token' }),
      // The person who granted it, as the connector hands it on: a keyed hash, never the Meta user id.
      grantedByHash: platformUserHash('meta-app-secret', META_GRANT.user),
    }));
  },
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
  const sandbox = adPlatforms({ sandbox: true });
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
    runAdsSync({ runtime: worker, broker: vault, platforms }, { orgId: org, connectionId });
  // The owner as the API's runtime sees a signed-in person: with the session the token carries.
  const asOwner = () => ({ type: 'user' as const, userId: owner.userId, aal: 'aal1' as const, sessionId: owner.session });
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
      channels: { broker: vault, sandbox: true, adsPlatforms: { ...sandbox, ...adPlatforms({ sandbox: false, meta: { appSecret: 'meta-app-secret' } }) }, connectors: { meta_ads: META_CONNECTOR }, publicUrl: 'https://ludy.example.test' },
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
    const { connectionId, adAccountId } = await connect('Đồng');
    const done = await sync(connectionId);
    expect(done.rows).toBeGreaterThan(1000);
    expect(done.slices).toBeGreaterThanOrEqual(13);
    const account = await view(owner, adAccountId);
    expect(account).toMatchObject({ currency: 'VND', timeZone: 'Asia/Ho_Chi_Minh', name: 'Đồng', lastErrorKind: null, nextRunAt: null });
    const today = todayIn('Asia/Ho_Chi_Minh', new Date());
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

  it('removes a day of the window the platform no longer reports, and keeps a final one', async () => {
    const { connectionId, adAccountId } = await connect('Bớt ngày');
    await sync(connectionId);
    const today = todayIn('Asia/Ho_Chi_Minh', new Date());
    const unsettled = new Date(Date.parse(today) - DAY_MS).toISOString().slice(0, 10);
    const count = async (day: string) => Number((await row<{ n: string }>(`SELECT count(*)::text AS n FROM crove_ads.ad_spend_day WHERE org_id = $1 AND ad_account_id = $2 AND day = $3`, [orgId, adAccountId, day]))[0]?.n);
    expect(await count(unsettled)).toBeGreaterThan(0);
    const silent: Readonly<Record<string, AdPlatform>> = { sandbox_ads: { ...(sandbox.sandbox_ads as AdPlatform), readDaily: async () => [] } };
    await sync(connectionId, silent);
    expect(await count(unsettled)).toBe(0);
    // A final day is never in the window, so an empty answer leaves it.
    const final = (await row<{ day: string }>(`SELECT day::text FROM crove_ads.ad_spend_day WHERE org_id = $1 AND ad_account_id = $2 AND settled_at IS NOT NULL LIMIT 1`, [orgId, adAccountId]))[0]?.day as string;
    expect(await count(final)).toBeGreaterThan(0);
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
    const { connectionId, adAccountId } = await connect('Rất nhiều chiến dịch');
    // 40 days of history, so the first read is a 31-day slice and a shorter one.
    await row(`UPDATE crove_ads.ad_account SET backfill_from = (now() AT TIME ZONE 'UTC')::date - 40 WHERE org_id = $1 AND id = $2`, [orgId, adAccountId]);
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
    // From the first day of history (40 days back, by the UTC date) to today in the account's zone.
    const first = new Date(Date.now() - 40 * DAY_MS).toISOString().slice(0, 10);
    const expectedDays = Math.round((Date.parse(todayIn('Asia/Ho_Chi_Minh', new Date())) - Date.parse(first)) / DAY_MS) + 1;
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
        // One question at a time, and only owners and admins ask.
        expect(await ask(adminAccount, { change: 'write_enable' })).toMatchObject({ status: 409, body: { code: 'ADS_REQUEST_OPEN' } });
        for (const who of [member, viewer]) expect((await ask(who, { change: 'write_enable' })).status, who.email).toBe(403);
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
        const id = proposalId(await ask(adminAccount, { change: 'account_enable', adAccountId }));
        expect(await ask(owner, { change: 'account_enable', adAccountId })).toMatchObject({ status: 409, body: { code: 'ADS_REQUEST_OPEN' } });
        expect((await view(owner, adAccountId))?.writeEnabled).toBe(false);
        expect((await approve(owner, id)).status).toBe(200);
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
        expect((await approve(owner, proposalId(await ask(adminAccount, orgCap)))).status).toBe(200);
        expect(await orgMonthly()).toEqual([expect.objectContaining({ amount: '5000000', currency: 'VND', setBy: owner.userId })]);
        // A raise is a proposal; a cap that is not above the one in force is refused, with the way to lower it.
        expect(await ask(owner, { ...orgCap, amount: '5000000.00' })).toMatchObject({ status: 422, body: { code: 'ADS_CAP_NOT_RAISED' } });
        expect(await ask(owner, { ...orgCap, amount: '4000000' })).toMatchObject({ status: 422, body: { code: 'ADS_CAP_NOT_RAISED' } });
        expect((await approve(owner, proposalId(await ask(adminAccount, { ...orgCap, amount: '8000000.50' })))).status).toBe(200);
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
        expect((await approve(owner, proposalId(await ask(adminAccount, { ...accountCap, currency: 'USD' })))).status).toBe(200);
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
        const id = proposalId(await ask(adminAccount, { change: 'launches_unblock' }));
        expect((await approve(owner, id)).status).toBe(200);
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
        await inContext(adminAccount, async (c) => {
          await approveRaw(c, capProposal);
          await refused(c, capSql, capParams('95000000', 'daily'), 'ADS_CAP_FORBIDDEN');
          await refused(c, capSql, capParams('90000000', 'monthly'), 'ADS_CAP_FORBIDDEN');
          await refused(c, on, [orgId]);
          await c.query(capSql, capParams('90000000', 'daily'));
        });
        // The system's kind of context never passes, even with a row in the state `approved`: only a user decides.
        await inContext('system', async (c) => {
          await c.query(`UPDATE crove_kernel.proposal SET status = 'approved', executed_command_id = $2::uuid, decided_at = now() WHERE org_id = $1 AND id = $3`, [orgId, randomUUID(), enable]);
          await refused(c, on, [orgId]);
        });
        // Clear what is left open in the org.
        for (const id of [enable, account, capProposal]) await reject(adminAccount, id);
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
      expect(audit.length).toBe(2);
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
    const read = (mode: 'ok' | 'limited' | 'expired') => ({ meta_ads: new MetaAdsPlatform({ ...meta, fetch: graph(mode) }) }) as Readonly<Record<string, AdPlatform>>;
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

    it('reads 13 months in the adapter\'s windows with only GET requests, and stores them in the account\'s currency and time zone', async () => {
      const listed = (await ok('ads/accounts', owner, undefined)) as AdAccountView[];
      const account = listed.find((a) => a.name === 'Meta act_9001') as AdAccountView;
      const result = await sync(account.connectionId, read('ok'));
      expect(result.rows).toBeGreaterThan(300 * 3);
      const after = ((await ok('ads/accounts', owner, undefined)) as AdAccountView[]).find((a) => a.id === account.id);
      expect(after).toMatchObject({ currency: 'VND', timeZone: 'Asia/Ho_Chi_Minh', lastErrorKind: null });
      // Meta restates its latest 28 days: the newest day is not final, one older than that is.
      expect(after?.settledThrough).toBe(new Date(Date.parse(todayIn('Asia/Ho_Chi_Minh', new Date())) - 29 * DAY_MS).toISOString().slice(0, 10));
      const today = todayIn('Asia/Ho_Chi_Minh', new Date());
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

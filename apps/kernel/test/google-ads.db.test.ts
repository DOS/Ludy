// SPDX-License-Identifier: AGPL-3.0-only
// Google Ads on PostgreSQL 17 (issue #2220, ADR-0040, plan docs/plan/ads.md slice B): OAuth start and finish for
// google_ads, short refresh-token expiry warning (connectionExpiresAt), single-account sync pass, and Uy's deterministic
// 7-day side-by-side comparison note across connected platforms.
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GoogleAdsPlatform, adPlatforms, type AdDailyRow, type AdPlatform } from '@crove/ad-platform';
import { ConnectorError, type OAuthConnector } from '@crove/channel';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { kernelCommands, kernelQueries } from '@crove/kernel';
import type { AdAccountView, AdsWeeklyNote } from '@crove/kernel-contract';
import { CredentialVault, parseVaultKey, Runtime, sha256Hex, type BlobStore } from '@crove/kernel-runtime';
import { addDays, adsCommands, adsQueries, todayIn } from '@crove/mod-ads';
import { createAuthenticator } from '../src/auth.ts';
import { runAdsSync } from '../src/ads-sync.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { createSessionStatusSource } from '../src/sessions.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const SECRET = 'test-only-jwt-secret-for-ads-0123456789-abcdefghij';
const ISSUER = 'crove-auth';
const GOOGLE_CLIENT_ID = '123456789012-abcdef0123456789.apps.googleusercontent.com';

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

suite('Google Ads and 7-day comparison note on PostgreSQL (#2220)', () => {
  const dbName = `crove_test_google_ads_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let app: ReturnType<typeof createHttpApp>;
  let api: Runtime;
  let worker: Runtime;
  let vault: CredentialVault;

  const owner: Account = { subject: randomUUID(), email: 'owner@google-ads.test', session: randomUUID(), userId: '' };
  let slug = '';
  let orgId = '';

  const googleGrantState = {
    failureCode: null as string | null,
    expiresAt: new Date('2026-11-11T00:00:00.000Z') as Date | null,
  };

  const googleConnector: OAuthConnector = {
    provider: 'google_ads',
    pkce: true,
    authorizeUrl: ({ state, redirectUri, codeChallenge }) =>
      `https://accounts.google.com/o/oauth2/v2/auth?client_id=${GOOGLE_CLIENT_ID}&state=${state}&redirect_uri=${encodeURIComponent(redirectUri)}&code_challenge=${codeChallenge ?? ''}`,
    exchange: async () => {
      if (googleGrantState.failureCode) {
        throw new ConnectorError('denied', 'Google refused the request', googleGrantState.failureCode);
      }
      return [
        {
          provider: 'google_ads',
          externalAccountId: '1234567890',
          displayName: 'Google Tìm kiếm VN',
          scopes: ['https://www.googleapis.com/auth/adwords'],
          expiresAt: googleGrantState.expiresAt,
          secret: JSON.stringify({ refreshToken: '1//google-refresh-token' }),
        },
      ];
    },
  };

  async function tokenFor(who: Account) {
    return new SignJWT({ role: 'authenticated', email: who.email, session_id: who.session, aal: 'aal1', is_anonymous: false })
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
    const config = loadConfig({
      DATABASE_URL: appUrl.toString(),
      AUTH_JWT_SECRET: SECRET,
      AUTH_ISSUER: ISSUER,
      AUTH_SESSION_CHECK: 'off',
      MIGRATIONS_DIR: MIGRATIONS,
      WEB_DIST: '/nonexistent',
    });
    const platforms = adPlatforms({
      sandbox: true,
      google: { clientId: GOOGLE_CLIENT_ID, clientSecret: 'google-client-secret' },
    });
    app = createHttpApp({
      config,
      runtime: api,
      store: new MemoryStore(),
      authenticate: createAuthenticator(config, db),
      pool,
      aiEnabled: false,
      channels: {
        broker: vault,
        sandbox: true,
        adsPlatforms: platforms,
        connectors: { google_ads: googleConnector },
        publicUrl: 'https://ludy.example.test',
      },
    });
    const workerUrl = new URL(adminUrl);
    workerUrl.username = 'crove_worker';
    workerUrl.password = 'test-worker-pw';
    workerPool = createPool({ connectionString: workerUrl.toString(), max: 2 });
    worker = new Runtime(createDb(workerPool), { manifests: TEST_MANIFESTS }).register(registered);

    const me = await rpc('me/get', await tokenFor(owner), undefined, null);
    expect(me.status).toBe(200);
    owner.userId = String(me.body?.userId);
    const created = await rpc('org/create', await tokenFor(owner), { name: 'Công ty Google Ads', idempotencyKey: randomUUID() }, null);
    slug = String(created.body?.slug);
    orgId = String(created.body?.orgId);
  }, 300_000);

  afterAll(async () => {
    await workerPool?.end();
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('refuses a Google Ads OAuth grant that reaches only manager accounts or uses a Test-only Cloud project with dedicated error codes', async () => {
    for (const [failureCode, expectedCode] of [
      ['MANAGER_ACCOUNT_UNSUPPORTED', 'OAUTH_GOOGLE_MANAGER_ONLY'],
      ['CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION', 'OAUTH_GOOGLE_PROJECT_TEST_ONLY'],
    ] as const) {
      googleGrantState.failureCode = failureCode;
      const started = (await ok('channels/oauthStart', owner, { provider: 'google_ads' })) as { state: string };
      const finished = await rpc('channels/oauthFinish', await tokenFor(owner), {
        provider: 'google_ads',
        state: started.state,
        code: 'auth-code-1',
      });
      expect(finished.status).toBe(422);
      expect(finished.body?.code).toBe(expectedCode);
    }
    googleGrantState.failureCode = null;
  });

  it('connects a Google Ads account via OAuth, surfaces connectionExpiresAt and conversion resultKinds, syncs single-account figures, and computes Uy’s 7-day comparison note', async () => {
    const started = (await ok('channels/oauthStart', owner, { provider: 'google_ads' })) as { authorizeUrl: string; state: string };
    expect(started.authorizeUrl).toContain('accounts.google.com/o/oauth2/v2/auth');

    const finished = (await ok('channels/oauthFinish', owner, {
      provider: 'google_ads',
      state: started.state,
      code: 'auth-code-ok',
    })) as { connections: Array<{ connectionId: string; displayName: string }> };
    expect(finished.connections).toHaveLength(1);
    const googleConnectionId = finished.connections[0]!.connectionId;

    const sandboxMade = (await ok('ads/connectSandbox', owner, {
      displayName: 'Thử nghiệm VND',
      currency: 'VND',
      idempotencyKey: randomUUID(),
    })) as { connectionId: string; adAccountId: string };

    const listedBefore = (await ok('ads/accounts', owner, undefined)) as AdAccountView[];
    const googleBefore = listedBefore.find((a) => a.provider === 'google_ads');
    expect(googleBefore).toMatchObject({
      connectionId: googleConnectionId,
      connectionStatus: 'active',
      connectionExpiresAt: '2026-11-11T00:00:00.000Z',
      extraScopes: [],
      provider: 'google_ads',
      name: 'Google Tìm kiếm VN',
      resultKinds: ['conversion'],
    });

    // Configure both accounts to count their respective result kinds.
    await ok('ads/configure', owner, {
      adAccountId: googleBefore!.id,
      resultKind: 'conversion',
      idempotencyKey: randomUUID(),
    });
    await ok('ads/configure', owner, {
      adAccountId: sandboxMade.adAccountId,
      resultKind: 'purchase',
      idempotencyKey: randomUUID(),
    });

    // Sync the Google Ads account and verify `accounts(secret, externalAccountId)` receives the single externalAccountId.
    const seenExternalAccountIds: Array<string | undefined> = [];
    const now = new Date();
    const today = todayIn('Asia/Ho_Chi_Minh', now);
    const yesterday = addDays(today, -1);
    const priorDay = addDays(today, -10);

    const fakeGooglePlatform: AdPlatform = {
      id: 'google_ads',
      hosts: new GoogleAdsPlatform({ clientId: GOOGLE_CLIENT_ID, clientSecret: 's' }).hosts,
      capabilities: { revisionDays: 30, resultKinds: ['conversion'] },
      accounts: async (_secret, externalAccountId) => {
        seenExternalAccountIds.push(externalAccountId);
        return [
          {
            externalAccountId: '1234567890',
            displayName: 'Google Tìm kiếm VN',
            currency: 'VND',
            timeZone: 'Asia/Ho_Chi_Minh',
          },
        ];
      },
      readDaily: async (_secret, externalAccountId, range): Promise<AdDailyRow[]> => {
        const rows: AdDailyRow[] = [];
        for (const [day, spend, conversions] of [
          [priorDay, '1000000', '10'],
          [yesterday, '1600000', '20'],
        ] as const) {
          if (day >= range.from && day <= range.to) {
            rows.push(
              {
                level: 'account',
                externalObjectId: externalAccountId,
                objectName: '',
                day,
                spend,
                impressions: 1000,
                clicks: 50,
                reach: null,
                results: { conversion: conversions },
              },
              {
                level: 'campaign',
                externalObjectId: 'camp-google-1',
                objectName: 'Tìm kiếm thương hiệu',
                day,
                spend,
                impressions: 1000,
                clicks: 50,
                reach: null,
                results: { conversion: conversions },
              },
            );
          }
        }
        return rows;
      },
    };

    const platforms = {
      ...adPlatforms({ sandbox: true, now: () => now }),
      google_ads: fakeGooglePlatform,
    };

    const googleSync = await runAdsSync({ runtime: worker, broker: vault, platforms, now: () => now }, { orgId, connectionId: googleConnectionId });
    expect(googleSync.rows).toBeGreaterThan(0);
    expect(seenExternalAccountIds).toEqual(['1234567890']);

    const sandboxSync = await runAdsSync({ runtime: worker, broker: vault, platforms, now: () => now }, { orgId, connectionId: sandboxMade.connectionId });
    expect(sandboxSync.rows).toBeGreaterThan(0);

    const notes = (await ok('ads/weeklyNote', owner, undefined)) as AdsWeeklyNote[];
    expect(notes).toHaveLength(1);
    const [vndNote] = notes;
    expect(vndNote?.currency).toBe('VND');
    expect(vndNote?.recentTo).toBe(yesterday);
    expect(vndNote?.platforms.map((p) => p.provider)).toEqual(['google_ads', 'sandbox_ads']);
    expect(vndNote?.platforms[0]).toMatchObject({
      provider: 'google_ads',
      accountCount: 1,
      recentSpend: '1600000',
      priorSpend: '1000000',
      spendDelta: '600000',
      resultKind: 'conversion',
      recentResults: '20',
      priorResults: '10',
      recentCostPerResult: '80000',
      priorCostPerResult: '100000',
      cprDelta: '-20000',
    });
    expect(vndNote?.topMover).not.toBeNull();
  });
});

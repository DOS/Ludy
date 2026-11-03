// SPDX-License-Identifier: AGPL-3.0-only
// Google Ads, read only (ADR-0040, #2220, slice B), against recorded answers written from Google's documentation: the consent screen's address, how a code
// becomes one connection per readable account, how the reader reads the accounts and the daily figures with GAQL (money in micros, exact), what each
// failure of Google means for the sync, and the pin on what the adapter can do at all: the two hosts, the pinned version, the endpoints its source
// names, no developer-token header and no query that changes anything. The live check records what Google really answers (docs/runbooks/ads-live-check.md).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ConnectorError, type Fetch } from '@crove/channel';
import {
  AD_PLATFORM_PROVIDERS,
  AdPlatformError,
  GOOGLE_ADS_API_VERSION,
  GOOGLE_ADS_HOSTS,
  GOOGLE_ADS_PROVIDER,
  GOOGLE_ADS_SCOPES,
  GoogleAdsConnector,
  GoogleAdsPlatform,
  adPlatforms,
  googleHostsOnly,
  isAdPlatformProvider,
  microsToDecimal,
} from '../src/index.ts';

const NOW = new Date('2026-11-03T08:00:00Z');
const APP = { clientId: '123456789012-abcdefghijklmnop.apps.googleusercontent.com', clientSecret: 'client-secret' };
const SECRET = JSON.stringify({ refreshToken: 'refresh-1' });
const redirectUri = 'https://ludy.example.test/channels/oauth/google_ads/callback';

interface Call {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: string | null;
}

type Answer = { status?: number; body: unknown } | Error;

// A fetch that answers from a list of recorded answers, in order, and remembers each request.
function recorded(answers: Answer[]): { fetch: Fetch; calls: Call[] } {
  const calls: Call[] = [];
  let i = 0;
  const fetch: Fetch = async (input, init) => {
    calls.push({ method: init?.method ?? 'GET', url: new URL(input), headers: Object.fromEntries(new Headers(init?.headers)), body: typeof init?.body === 'string' ? init.body : null });
    const next = answers[i++];
    if (!next) throw new Error(`no recorded answer for ${input}`);
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next.body), { status: next.status ?? 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetch, calls };
}

const platform = (answers: Answer[]) => {
  const { fetch, calls } = recorded(answers);
  return { platform: new GoogleAdsPlatform({ ...APP, fetch, now: () => NOW }), calls };
};
const connector = (answers: Answer[]) => {
  const { fetch, calls } = recorded(answers);
  return { connector: new GoogleAdsConnector(APP, { fetch }), calls };
};

const TOKEN = { body: { access_token: 'access-1', expires_in: 3599, token_type: 'Bearer' } };
const LIST = { body: { resourceNames: ['customers/1234567890', 'customers/2345678901', 'customers/3456789012'] } };
const customer = (over: Record<string, unknown> = {}) => ({
  body: [{ results: [{ customer: { resourceName: 'customers/1', id: '1', descriptiveName: 'Cửa hàng A', currencyCode: 'VND', timeZone: 'Asia/Ho_Chi_Minh', manager: false, status: 'ENABLED', ...over } }], requestId: 'r' }],
});
const googleError = (status: number, statusWord: string, errorCode?: Record<string, string>, retryDelay?: string) => ({
  status,
  body: {
    error: {
      code: status,
      message: 'Google text that names an account',
      status: statusWord,
      details: [
        ...(errorCode ? [{ '@type': 'type.googleapis.com/google.ads.googleads.v26.errors.GoogleAdsFailure', errors: [{ errorCode, message: 'text' }] }] : []),
        ...(retryDelay ? [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay }] : []),
      ],
    },
  },
});
const rejection = async (promise: Promise<unknown>): Promise<AdPlatformError> => {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(AdPlatformError);
  return error as AdPlatformError;
};

describe('the Google Ads connection', () => {
  const grant = { body: { access_token: 'access-1', refresh_token: 'refresh-1', scope: 'https://www.googleapis.com/auth/adwords', expires_in: 3599 } };

  it('sends the browser to Google\'s consent screen for the Ads scope with offline access and PKCE', () => {
    const c = connector([]).connector;
    const url = new URL(c.authorizeUrl({ state: 'state-1', redirectUri, codeChallenge: 'challenge-1' }));
    expect([c.provider, GOOGLE_ADS_PROVIDER, c.pkce]).toEqual(['google_ads', 'google_ads', true]);
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(GOOGLE_ADS_SCOPES).toEqual(['https://www.googleapis.com/auth/adwords']);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: APP.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'https://www.googleapis.com/auth/adwords',
      state: 'state-1',
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'false',
      code_challenge: 'challenge-1',
      code_challenge_method: 'S256',
    });
  });

  it('turns a code into one connection per readable account, each sealing the same refresh token and no date', async () => {
    const { connector: c, calls } = connector([grant, LIST, customer({ id: '1234567890', descriptiveName: 'Cửa hàng A' }), customer({ id: '2345678901', manager: true }), customer({ id: '3456789012', status: 'CANCELED' })]);
    const accounts = await c.exchange({ code: 'the-code', redirectUri, codeVerifier: 'verifier-1' });
    expect(accounts).toEqual([
      { provider: 'google_ads', externalAccountId: '1234567890', displayName: 'Cửa hàng A', scopes: ['https://www.googleapis.com/auth/adwords'], expiresAt: null, secret: JSON.stringify({ refreshToken: 'refresh-1' }) },
    ]);
    // The code goes to the token endpoint with the verifier, the project's client and secret; then one list and one query per accessible account.
    expect(calls.map((x) => [x.method, x.url.host, x.url.pathname])).toEqual([
      ['POST', 'oauth2.googleapis.com', '/token'],
      ['GET', 'googleads.googleapis.com', `/${GOOGLE_ADS_API_VERSION}/customers:listAccessibleCustomers`],
      ['POST', 'googleads.googleapis.com', `/${GOOGLE_ADS_API_VERSION}/customers/1234567890/googleAds:searchStream`],
      ['POST', 'googleads.googleapis.com', `/${GOOGLE_ADS_API_VERSION}/customers/2345678901/googleAds:searchStream`],
      ['POST', 'googleads.googleapis.com', `/${GOOGLE_ADS_API_VERSION}/customers/3456789012/googleAds:searchStream`],
    ]);
    expect(Object.fromEntries(new URLSearchParams(calls[0]?.body ?? ''))).toEqual({
      client_id: APP.clientId,
      client_secret: 'client-secret',
      grant_type: 'authorization_code',
      code: 'the-code',
      redirect_uri: redirectUri,
      code_verifier: 'verifier-1',
    });
  });

  it('makes no connection when the person reaches no readable account (the caller says so in words of its own)', async () => {
    expect(await connector([grant, { body: {} }]).connector.exchange({ code: 'c', redirectUri, codeVerifier: null })).toEqual([]);
  });

  it('refuses a grant without the Ads permission, without a refresh token, and a code Google no longer accepts', async () => {
    const missing = await connector([{ body: { access_token: 'a', refresh_token: 'r', scope: 'openid' } }]).connector.exchange({ code: 'c', redirectUri, codeVerifier: null }).catch((e: unknown) => e);
    expect(missing).toBeInstanceOf(ConnectorError);
    expect(missing).toMatchObject({ kind: 'denied', code: 'MISSING_PERMISSION' });
    const noRefresh = await connector([{ body: { access_token: 'a', scope: 'https://www.googleapis.com/auth/adwords' } }]).connector.exchange({ code: 'c', redirectUri, codeVerifier: null }).catch((e: unknown) => e);
    expect(noRefresh).toMatchObject({ kind: 'provider' });
    const used = await connector([{ status: 400, body: { error: 'invalid_grant', error_description: 'Bad Request' } }]).connector.exchange({ code: 'c', redirectUri, codeVerifier: null }).catch((e: unknown) => e);
    expect(used).toMatchObject({ kind: 'invalid_grant' });
  });

  it('makes no connection when a project that is not approved for production accounts is refused for each account (the caller says so)', async () => {
    const refused = googleError(403, 'PERMISSION_DENIED', { authorizationError: 'CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION' });
    // Each account answers a missing permission, so each is left out and nothing is readable; any other failure would end the connect with a typed error.
    expect(await connector([grant, LIST, refused, refused, refused]).connector.exchange({ code: 'c', redirectUri, codeVerifier: null })).toEqual([]);
    const limited = await connector([grant, LIST, googleError(429, 'RESOURCE_EXHAUSTED')]).connector.exchange({ code: 'c', redirectUri, codeVerifier: null }).catch((e: unknown) => e);
    expect(limited).toBeInstanceOf(ConnectorError);
    expect(limited).toMatchObject({ kind: 'provider', code: 'RESOURCE_EXHAUSTED' });
  });

  it('refuses a client id or a secret that is not a Google OAuth client\'s', () => {
    expect(() => new GoogleAdsConnector({ clientId: 'not-a-client', clientSecret: 'x' })).toThrow('invalid Google client id');
    expect(() => new GoogleAdsConnector({ clientId: APP.clientId, clientSecret: '' })).toThrow('missing Google client secret');
    expect(() => new GoogleAdsConnector(APP, { version: 'latest' })).toThrow('invalid Google Ads API version');
  });
});

describe('the Google Ads reader', () => {
  const account = (id: string) => customer({ id, descriptiveName: `Account ${id}` });

  it('names the accounts the refresh token reaches with their currency and time zone, asking for an access token each time', async () => {
    const { platform: p, calls } = platform([TOKEN, LIST, account('1234567890'), customer({ manager: true }), customer({ currencyCode: 'usd' })]);
    expect(await p.accounts(SECRET)).toEqual([{ externalAccountId: '1234567890', displayName: 'Account 1234567890', currency: 'VND', timeZone: 'Asia/Ho_Chi_Minh' }]);
    expect(Object.fromEntries(new URLSearchParams(calls[0]?.body ?? ''))).toEqual({ client_id: APP.clientId, client_secret: 'client-secret', grant_type: 'refresh_token', refresh_token: 'refresh-1' });
    // The access token goes in the header after that, and the refresh token and the secret in no URL.
    expect(calls.slice(1).every((c) => c.headers.authorization === 'Bearer access-1')).toBe(true);
    expect(calls.every((c) => !c.url.toString().includes('refresh-1') && !c.url.toString().includes('access-1') && !c.url.toString().includes('client-secret'))).toBe(true);
  });

  it('reads the account\'s days and each campaign\'s with two queries, money exact from micros, conversions as the one result kind and no reach', async () => {
    const days = {
      body: [
        {
          results: [
            { segments: { date: '2026-11-01' }, metrics: { costMicros: '12500000', impressions: '1200', clicks: '34', conversions: 2.5 } },
            { segments: { date: '2026-11-02' }, metrics: { costMicros: '1', impressions: '0', clicks: '0', conversions: 0 } },
          ],
        },
        { results: [{ segments: { date: '2026-11-03' }, metrics: { costMicros: '999999999999', impressions: '9', clicks: '1', conversions: 0.00004 } }] },
      ],
    };
    const campaigns = {
      body: [{ results: [{ campaign: { id: '555', name: 'Khuyến mãi' }, segments: { date: '2026-11-01' }, metrics: { costMicros: '12500000', impressions: '1200', clicks: '34', conversions: 1 } }] }],
    };
    const { platform: p, calls } = platform([TOKEN, days, campaigns]);
    const rows = await p.readDaily(SECRET, '1234567890', { from: '2026-11-01', to: '2026-11-03' });
    expect(rows).toEqual([
      { level: 'account', externalObjectId: '1234567890', objectName: '', day: '2026-11-01', spend: '12.5', impressions: 1200, clicks: 34, reach: null, results: { conversion: '2.5' } },
      { level: 'account', externalObjectId: '1234567890', objectName: '', day: '2026-11-02', spend: '0.000001', impressions: 0, clicks: 0, reach: null, results: {} },
      { level: 'account', externalObjectId: '1234567890', objectName: '', day: '2026-11-03', spend: '999999.999999', impressions: 9, clicks: 1, reach: null, results: {} },
      { level: 'campaign', externalObjectId: '555', objectName: 'Khuyến mãi', day: '2026-11-01', spend: '12.5', impressions: 1200, clicks: 34, reach: null, results: { conversion: '1' } },
    ]);
    expect(calls.map((c) => [c.method, c.url.pathname])).toEqual([
      ['POST', '/token'],
      ['POST', `/${GOOGLE_ADS_API_VERSION}/customers/1234567890/googleAds:searchStream`],
      ['POST', `/${GOOGLE_ADS_API_VERSION}/customers/1234567890/googleAds:searchStream`],
    ]);
    expect(JSON.parse(calls[1]?.body ?? '{}')).toEqual({
      query: "SELECT segments.date, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions FROM customer WHERE segments.date BETWEEN '2026-11-01' AND '2026-11-03'",
    });
    expect(JSON.parse(calls[2]?.body ?? '{}')).toEqual({
      query: "SELECT campaign.id, campaign.name, segments.date, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions FROM campaign WHERE segments.date BETWEEN '2026-11-01' AND '2026-11-03'",
    });
  });

  it('leaves out a row that is not a day with its money and counts, and a campaign row with no id', async () => {
    const odd = { body: [{ results: [{ segments: { date: 'yesterday' }, metrics: { costMicros: '1', impressions: '1', clicks: '1' } }, { segments: { date: '2026-11-01' }, metrics: { costMicros: '-5', impressions: '1', clicks: '1' } }, { segments: { date: '2026-11-01' }, metrics: { costMicros: '5', impressions: 'x', clicks: '1' } }] }] };
    const noId = { body: [{ results: [{ campaign: { name: 'no id' }, segments: { date: '2026-11-01' }, metrics: { costMicros: '5', impressions: '1', clicks: '1' } }] }] };
    const { platform: p } = platform([TOKEN, odd, noId]);
    expect(await p.readDaily(SECRET, '1234567890', { from: '2026-11-01', to: '2026-11-01' })).toEqual([]);
  });

  it('answers nothing for a day with no rows, and refuses a range or an account id that is not one, without calling Google', async () => {
    const empty = { body: [{ fieldMask: 'x' }] };
    expect(await platform([TOKEN, empty, empty]).platform.readDaily(SECRET, '1234567890', { from: '2026-11-01', to: '2026-11-01' })).toEqual([]);
    for (const [id, range] of [
      ['123', { from: '2026-11-01', to: '2026-11-02' }],
      ['1234567890', { from: '2026-11-03', to: '2026-11-02' }],
      ['1234567890', { from: "2026-11-01' OR 1=1", to: '2026-11-02' }],
    ] as const) {
      const { platform: p, calls } = platform([]);
      expect((await rejection(p.readDaily(SECRET, id, range))).code).toBe('BAD_RANGE');
      expect(calls).toHaveLength(0);
    }
  });

  it('refuses a secret that holds no refresh token as a refused token, without calling Google', async () => {
    for (const secret of ['nope', '{}', JSON.stringify({ refreshToken: '' }), JSON.stringify({ accessToken: 'a' })]) {
      const { platform: p, calls } = platform([]);
      const error = await rejection(p.accounts(secret));
      expect([error.kind, error.code]).toEqual(['token_expired', 'BAD_SECRET']);
      expect(calls).toHaveLength(0);
    }
  });

  it('declares what it is: the two hosts, the conversion as a result kind and a settled day after thirty days', () => {
    const p = platform([]).platform;
    expect(p.id).toBe('google_ads');
    expect(p.hosts).toEqual(['googleads.googleapis.com', 'oauth2.googleapis.com']);
    expect(p.capabilities).toEqual({ revisionDays: 30, resultKinds: ['conversion'] });
  });
});

describe('what each failure of Google means for the sync', () => {
  const read = (answers: Answer[]) => platform(answers).platform.readDaily(SECRET, '1234567890', { from: '2026-11-01', to: '2026-11-02' });

  it('records a refresh token that was revoked, expired or unused as a refused token, never retried', async () => {
    const e = await rejection(read([{ status: 400, body: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } }]));
    expect([e.kind, e.code]).toEqual(['token_expired', 'invalid_grant']);
    expect((await rejection(read([TOKEN, googleError(401, 'UNAUTHENTICATED')]))).kind).toBe('token_expired');
  });

  it('says a wrong client id or secret is a permission problem of the project, with Google\'s own word', async () => {
    const e = await rejection(read([{ status: 401, body: { error: 'invalid_client' } }]));
    expect([e.kind, e.code]).toEqual(['permission', 'invalid_client']);
  });

  it('says a refused permission by the Ads API\'s own code, so the screen can tell the owner to apply for Explorer access', async () => {
    const e = await rejection(read([TOKEN, googleError(403, 'PERMISSION_DENIED', { authorizationError: 'CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION' })]));
    expect([e.kind, e.code]).toEqual(['permission', 'CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION']);
    const noCode = await rejection(read([TOKEN, googleError(403, 'PERMISSION_DENIED')]));
    expect([noCode.kind, noCode.code]).toEqual(['permission', 'PERMISSION_DENIED']);
  });

  it('waits for the time Google names when a limit is hit, an hour when it names none, a few minutes for the temporary limit', async () => {
    const named = await rejection(read([TOKEN, googleError(429, 'RESOURCE_EXHAUSTED', { quotaError: 'RESOURCE_EXHAUSTED' }, '7200s')]));
    expect([named.kind, named.code, named.retryAt?.toISOString()]).toEqual(['rate_limited', 'RESOURCE_EXHAUSTED', '2026-11-03T10:00:00.000Z']);
    const bare = await rejection(read([TOKEN, googleError(429, 'RESOURCE_EXHAUSTED')]));
    expect(bare.retryAt?.toISOString()).toBe('2026-11-03T09:00:00.000Z');
    const temporary = await rejection(read([TOKEN, googleError(429, 'RESOURCE_EXHAUSTED', { quotaError: 'RESOURCE_TEMPORARILY_EXHAUSTED' })]));
    expect([temporary.kind, temporary.code, temporary.retryAt?.toISOString()]).toEqual(['rate_limited', 'RESOURCE_TEMPORARILY_EXHAUSTED', '2026-11-03T08:05:00.000Z']);
  });

  it('types Google\'s own failure as transient, a bad query as a bad request, and a lost connection as transient', async () => {
    expect((await rejection(read([TOKEN, googleError(503, 'UNAVAILABLE')]))).kind).toBe('transient');
    expect((await rejection(read([TOKEN, googleError(500, 'INTERNAL')]))).kind).toBe('transient');
    expect((await rejection(read([TOKEN, googleError(400, 'INVALID_ARGUMENT', { queryError: 'PROHIBITED_METRIC_IN_SELECT_OR_WHERE_CLAUSE' })]))).code).toBe('PROHIBITED_METRIC_IN_SELECT_OR_WHERE_CLAUSE');
    const network = await rejection(read([Object.assign(new Error('aborted'), { name: 'AbortError' })]));
    expect([network.kind, network.code]).toEqual(['transient', 'NETWORK']);
  });

  it('keeps no text of Google\'s: the error carries its kind and Google\'s code only', async () => {
    const e = await rejection(read([TOKEN, googleError(403, 'PERMISSION_DENIED', { authorizationError: 'USER_PERMISSION_DENIED' })]));
    expect(e.message).toBe('ad platform error: permission USER_PERMISSION_DENIED');
    expect(e.message).not.toContain('names an account');
  });

  it('leaves out an account that answers a missing permission when naming the accounts, and fails on anything else', async () => {
    const { platform: p } = platform([TOKEN, LIST, googleError(403, 'PERMISSION_DENIED', { authorizationError: 'USER_PERMISSION_DENIED' }), customer({ id: '2345678901' }), customer({ id: '3456789012' })]);
    expect((await p.accounts(SECRET)).map((a) => a.externalAccountId)).toEqual(['2345678901', '3456789012']);
    const limited = await rejection(platform([TOKEN, LIST, googleError(429, 'RESOURCE_EXHAUSTED')]).platform.accounts(SECRET));
    expect(limited.kind).toBe('rate_limited');
  });
});

describe('money from micros', () => {
  it('is exact: no float, six places at most, no trailing zero', () => {
    expect(microsToDecimal('0')).toBe('0');
    expect(microsToDecimal('1')).toBe('0.000001');
    expect(microsToDecimal('1000000')).toBe('1');
    expect(microsToDecimal('1500000')).toBe('1.5');
    expect(microsToDecimal('123456789012345678')).toBe('123456789012.345678');
    expect(microsToDecimal(2_500_000)).toBe('2.5');
    // 0.1 + 0.2 style traps: the amount is read as an integer, never as a double.
    expect(microsToDecimal('300000')).toBe('0.3');
  });

  it('refuses what is not a non-negative whole number of micros', () => {
    for (const bad of ['-1', '1.5', 'x', '', '1234567890123456789', null, undefined, 1.5, -1, {}]) expect(microsToDecimal(bad), String(bad)).toBeNull();
  });
});

describe('what the adapter can reach and do at all', () => {
  const source = readFileSync(new URL('../src/google.ts', import.meta.url), 'utf8');

  it('goes to the two hosts of Google over https and nowhere else, and follows no redirect', async () => {
    expect(GOOGLE_ADS_HOSTS).toEqual(['googleads.googleapis.com', 'oauth2.googleapis.com']);
    const { fetch, calls } = recorded([{ body: {} }]);
    const guarded = googleHostsOnly(fetch);
    for (const url of ['https://evil.example/x', 'http://googleads.googleapis.com/v26/x', 'https://user:pass@googleads.googleapis.com/x', 'https://googleads.googleapis.com.evil.example/x', 'https://oauth2.googleapis.com:8443/token', 'not a url']) {
      await expect(guarded(url), url).rejects.toMatchObject({ kind: 'unknown', code: 'HOST_NOT_ALLOWED' });
    }
    expect(calls).toHaveLength(0);
    await guarded('https://googleads.googleapis.com/v26/customers:listAccessibleCustomers');
    expect(calls).toHaveLength(1);
  });

  it('pins one API version', async () => {
    expect(GOOGLE_ADS_API_VERSION).toBe('v26');
    const { platform: p, calls } = platform([TOKEN, LIST, customer(), customer(), customer()]);
    await p.accounts(SECRET);
    expect(calls.slice(1).every((c) => c.url.pathname.startsWith('/v26/'))).toBe(true);
  });

  it('names exactly these requests: the token endpoint, the account list and the stream of a query', () => {
    const requests = [...source.matchAll(/this\.fetch\(\s*([^,]+),\s*\{\s*method: '([A-Z]+)'/g)].map((m) => [m[2], m[1]]);
    expect(requests).toEqual([
      ['POST', "'https://oauth2.googleapis.com/token'"],
      ['GET', '`https://googleads.googleapis.com/${this.version}/customers:listAccessibleCustomers`'],
      ['POST', '`https://googleads.googleapis.com/${this.version}/customers/${customerId}/googleAds:searchStream`'],
    ]);
    expect(source).not.toMatch(/'(PUT|PATCH|DELETE)'|:mutate|googleAds:search'|\.mutate\(/);
  });

  it('only reads: every query is a SELECT, built from fixed text with a checked day and a ten-digit account', () => {
    expect(source).toContain("const ACCOUNT_QUERY = 'SELECT customer.id,");
    expect(source).toContain('`SELECT segments.date, ${METRICS} FROM customer ${accountDay(from, to)}`');
    expect(source).toContain('`SELECT campaign.id, campaign.name, segments.date, ${METRICS} FROM campaign ${accountDay(from, to)}`');
    expect(source).not.toMatch(/\b(MUTATE|INSERT|UPDATE|REMOVE|CREATE)\b/);
  });

  it('never sends the developer-token header: the tokens were sunset, the header is optional and will be rejected', () => {
    for (const line of source.split('\n')) if (/developer-token|developer_token|login-customer-id/i.test(line)) expect(line.trim().startsWith('//'), line).toBe(true);
  });

  it('is a platform of the readers\' registry only where the project\'s client is set', () => {
    expect(AD_PLATFORM_PROVIDERS).toContain('google_ads');
    expect(isAdPlatformProvider('google_ads')).toBe(true);
    expect(Object.keys(adPlatforms({ sandbox: true }))).toEqual(['sandbox_ads']);
    expect(Object.keys(adPlatforms({ sandbox: false, google: APP }))).toEqual(['google_ads']);
    expect(Object.keys(adPlatforms({ sandbox: true, meta: { appSecret: 'x' }, google: APP }))).toEqual(['sandbox_ads', 'meta_ads', 'google_ads']);
  });
});

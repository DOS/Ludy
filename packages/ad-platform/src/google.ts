// SPDX-License-Identifier: AGPL-3.0-only
// Google Ads, read only (ADR-0040, plan docs/plan/ads.md sections 4 and 5, issue #2220, slice B), written from Google's Ads API docs and re-checked
// against them on 2026-11-03 (the plan says where). Each deployment brings its own Google Cloud project and OAuth client (CHANNEL_GOOGLE_ADS_CLIENT_ID
// and CHANNEL_GOOGLE_ADS_CLIENT_SECRET, the owner's answer Q3 on #2214): DOS holds no shared project. The connection is one channel connection per
// Google Ads account (ADR-0025): Google's consent screen for the restricted scope `adwords` with offline access, whose refresh token is what the
// connection seals (an access token lives an hour, so the reader asks for a new one when it reads); `customers:listAccessibleCustomers` lists the
// accounts the person can reach and one query per account names it, its currency and its time zone.
//
// Access is the Google Cloud project's, not a developer token's: the tokens were sunset on 2026-09-09 and the `developer-token` header is optional
// and ignored by the servers (Google will reject it in a future major version), so this adapter never sends it and the config has no setting for it. A
// project at Test access reaches only test accounts; the owner applies for Explorer access (2,880 operations a day on production accounts, an
// automated review, no brand verification) in the Cloud Console, and the runbook says so. A project not yet approved for production answers a
// permission error, which the screen words. Accounts reachable only through a manager account need the `login-customer-id` header and are not
// supported: the person signs in with a Google account that reaches the ad account directly, and a login that reaches only manager accounts is
// refused with `MANAGER_ACCOUNT_UNSUPPORTED`.
//
// Reading only: every request is a GET of the account list or a POST of one `googleAds:searchStream` query (a read, one operation however many
// batches it streams), and the token endpoint. The queries are fixed text with only dates (checked against a pattern) and an account id (ten
// digits) in them, and a test pins the endpoints, the hosts and that no query changes anything. Both hosts are named below; a request to any other,
// a plain http one, or one with credentials in the address is refused before it leaves, and nothing redirects.
import type { AuthorizeInput, ConnectedAccount, ExchangeInput, Fetch, OAuthConnector } from '@crove/channel';
import { ConnectorError, allowlistedFetch } from '@crove/channel';
import { AdPlatformError, type AdDailyRow, type AdPlatform, type AdPlatformAccount, type AdPlatformCapabilities } from './index.ts';

export const GOOGLE_ADS_PROVIDER = 'google_ads' as const;
// The one scope Google Ads has. Google classes it restricted: verification is not needed for personal use (the owner's own project and account),
// and a person sees Google's warning screen on an unverified app (the runbook tells them to continue through Advanced).
export const GOOGLE_ADS_SCOPES = ['https://www.googleapis.com/auth/adwords'] as const;
// One pinned version, as for Meta: v26 was released on 2026-10-14 and sunsets in November 2027, and a request to a sunset version fails.
export const GOOGLE_ADS_API_VERSION = 'v26';
export const GOOGLE_ADS_HOSTS = ['googleads.googleapis.com', 'oauth2.googleapis.com'] as const;
export const GOOGLE_CUSTOMER_ID = /^\d{10}$/;
const CLIENT_ID = /^[0-9]{6,32}-[A-Za-z0-9_-]{8,64}\.apps\.googleusercontent\.com$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const SAFE_CODE = /^[A-Za-z0-9_.]{1,64}$/;
const MAX_ACCOUNTS = 200;
const REQUEST_TIMEOUT_MS = 30_000;

const safeCode = (value: unknown): string | undefined => (typeof value === 'string' && SAFE_CODE.test(value) ? value : undefined);
const parseDelayMs = (value: unknown): number | undefined => {
  const match = typeof value === 'string' ? /^(\d{1,9})(?:\.\d+)?s$/.exec(value) : null;
  return match ? Number(match[1]) * 1000 : undefined;
};

// A day older than this is settled: conversions are attributed to the day of the click and can be added for the conversion window (30 days by
// default) [U: the live check confirms what a given account's window is]. The platform's own cost figure can be restated for days.
const GOOGLE_REVISION_DAYS = 30;
// A conversion is the one result kind Google's reports give without knowing the account's conversion actions: the account's primary conversions.
const GOOGLE_CAPABILITIES: AdPlatformCapabilities = { revisionDays: GOOGLE_REVISION_DAYS, resultKinds: ['conversion'] };

// How long a rate limit holds an account back when Google's answer names no time: the daily operation quota is reset at midnight Pacific [U], so
// an hour is tried, and a short wait for the temporary limit.
const RATE_LIMITED_DELAY_MS = 60 * 60_000;
const TEMPORARILY_EXHAUSTED_DELAY_MS = 5 * 60_000;

export interface GoogleAdsAppConfig {
  clientId: string;
  clientSecret: string;
}

// What each account's connection seals: the refresh token. The access token is never stored (it lives an hour).
interface GoogleAdsSecret {
  refreshToken: string;
}

function parseSecret(secret: string): GoogleAdsSecret {
  let parsed: unknown;
  try {
    parsed = JSON.parse(secret);
  } catch {
    throw new AdPlatformError('token_expired', 'BAD_SECRET');
  }
  const token = (parsed as { refreshToken?: unknown } | null)?.refreshToken;
  if (typeof token !== 'string' || !token) throw new AdPlatformError('token_expired', 'BAD_SECRET');
  return { refreshToken: token };
}

// A failure of Google's servers: the HTTP status and what the answer names (a status word, an error code of the Ads API, an OAuth error, a retry delay).
// The message is never kept: it can carry a name.
class GoogleAdsHttpError extends Error {
  readonly status: number;
  readonly oauth: string | undefined;
  readonly code: string | undefined;
  readonly statusWord: string | undefined;
  readonly retryAfterMs: number | undefined;
  constructor(status: number, body: Record<string, unknown> | null) {
    super(`Google answered ${status}`);
    this.name = 'GoogleAdsHttpError';
    this.status = status;
    // The token endpoint's own shape: `{ error: 'invalid_grant' }`.
    this.oauth = safeCode(body?.error);
    const error = body?.error !== null && typeof body?.error === 'object' ? (body?.error as { status?: unknown; details?: unknown }) : null;
    this.statusWord = safeCode(error?.status);
    let code: string | undefined;
    let retry: number | undefined;
    for (const detail of Array.isArray(error?.details) ? (error.details as Array<Record<string, unknown>>) : []) {
      // The Ads API's failure: each error names its code as the one key of `errorCode`, such as `authorizationError: USER_PERMISSION_DENIED`,
      // and a quota failure carries its wait in `details.quotaErrorDetails.retryDelay`.
      for (const e of Array.isArray(detail.errors) ? (detail.errors as Array<{ errorCode?: unknown; details?: unknown }>) : []) {
        const entries = e.errorCode !== null && typeof e.errorCode === 'object' ? Object.values(e.errorCode as Record<string, unknown>) : [];
        const first = entries.find((v) => safeCode(v) !== undefined);
        if (code === undefined && typeof first === 'string') code = first;
        const quota = e.details !== null && typeof e.details === 'object' ? (e.details as { quotaErrorDetails?: { retryDelay?: unknown } }).quotaErrorDetails : undefined;
        const wait = parseDelayMs(quota?.retryDelay);
        if (retry === undefined && wait !== undefined) retry = wait;
      }
      // Google's RetryInfo: how long to wait, as seconds with an s.
      const wait = parseDelayMs(detail.retryDelay);
      if (retry === undefined && wait !== undefined) retry = wait;
    }
    this.code = code;
    this.retryAfterMs = retry;
  }
}

// A failure as the channel layer types an error (plan section 5.3): only Google's code is kept, never its text.
export function googleAdsError(error: unknown, now: () => Date = () => new Date()): AdPlatformError {
  if (error instanceof AdPlatformError) return error;
  if (error instanceof GoogleAdsHttpError) {
    const code = safeCode(error.oauth ?? error.code ?? error.statusWord) ?? String(error.status);
    // The refresh token was revoked, expired (an app in testing mode gets 7 day tokens) or unused for six months: recorded, never retried.
    if (error.oauth === 'invalid_grant') return new AdPlatformError('token_expired', code);
    // The project's own client id or secret is wrong.
    if (error.oauth === 'invalid_client' || error.oauth === 'unauthorized_client') return new AdPlatformError('permission', code);
    if (error.status === 401 || error.statusWord === 'UNAUTHENTICATED') return new AdPlatformError('token_expired', code);
    if (error.status === 429 || error.statusWord === 'RESOURCE_EXHAUSTED' || error.code === 'RESOURCE_TEMPORARILY_EXHAUSTED') {
      const wait = error.retryAfterMs ?? (error.code === 'RESOURCE_TEMPORARILY_EXHAUSTED' ? TEMPORARILY_EXHAUSTED_DELAY_MS : RATE_LIMITED_DELAY_MS);
      return new AdPlatformError('rate_limited', code, new Date(now().getTime() + wait));
    }
    // A missing permission, an account the person cannot read, or a project not yet approved for production accounts (CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION).
    if (error.status === 403 || error.statusWord === 'PERMISSION_DENIED') return new AdPlatformError('permission', code);
    if (error.status >= 500) return new AdPlatformError('transient', code);
    if (error.status === 400 || error.status === 404) return new AdPlatformError('bad_request', code);
    return new AdPlatformError('unknown', code);
  }
  // fetch's own failure (DNS, TLS, a timeout or an abort): worth another try later.
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError' || (error instanceof TypeError && /fetch failed/i.test(error.message)))) return new AdPlatformError('transient', 'NETWORK');
  return new AdPlatformError('unknown');
}

// The fetch of this adapter and its connector: https, one of the two hosts, no credentials in the address, no redirect (the channel layer's
// allowlisted fetch follows none) and a time limit.
export function googleHostsOnly(fetchImpl?: Fetch): Fetch {
  const guarded = allowlistedFetch(GOOGLE_ADS_HOSTS, fetchImpl, REQUEST_TIMEOUT_MS);
  return async (input, init) => {
    let url: URL;
    try {
      url = new URL(input);
    } catch {
      throw new AdPlatformError('unknown', 'HOST_NOT_ALLOWED');
    }
    if (url.protocol !== 'https:' || !(GOOGLE_ADS_HOSTS as readonly string[]).includes(url.host) || url.username !== '' || url.password !== '') throw new AdPlatformError('unknown', 'HOST_NOT_ALLOWED');
    return guarded(input, init);
  };
}

interface TokenAnswer {
  access_token?: unknown;
  refresh_token?: unknown;
  refresh_token_expires_in?: unknown;
  scope?: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

// What the platform and the connector share: the project's client, the token endpoint, and the two Ads API requests.
class GoogleAdsClient {
  private readonly fetch: Fetch;
  private readonly app: GoogleAdsAppConfig;
  private readonly version: string;

  constructor(app: GoogleAdsAppConfig, fetchImpl?: Fetch, version: string = GOOGLE_ADS_API_VERSION) {
    if (!CLIENT_ID.test(app.clientId)) throw new Error('invalid Google client id');
    if (!app.clientSecret) throw new Error('missing Google client secret');
    if (!/^v\d{1,3}(\.\d{1,2})?$/.test(version)) throw new Error('invalid Google Ads API version');
    this.app = app;
    this.fetch = googleHostsOnly(fetchImpl);
    this.version = version;
  }

  get clientId(): string {
    return this.app.clientId;
  }

  // The token endpoint: a code for tokens, or a refresh token for an access token.
  async token(form: Record<string, string>): Promise<TokenAnswer> {
    const response = await this.fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ client_id: this.app.clientId, client_secret: this.app.clientSecret, ...form }).toString(),
    });
    const json = (await response.json().catch(() => null)) as unknown;
    if (!response.ok) throw new GoogleAdsHttpError(response.status, isRecord(json) ? json : null);
    if (!isRecord(json)) throw new AdPlatformError('transient', 'BAD_STREAM');
    return json as TokenAnswer;
  }

  // An access token for a refresh token, asked for each time the reader reads: it lives an hour and is never stored.
  async accessToken(refreshToken: string): Promise<string> {
    const answer = await this.token({ grant_type: 'refresh_token', refresh_token: refreshToken });
    if (typeof answer.access_token !== 'string' || !answer.access_token) throw new AdPlatformError('transient', 'NO_ACCESS_TOKEN');
    return answer.access_token;
  }

  // The accounts the signed-in person can reach directly (resource names `customers/<ten digits>`).
  async listAccessible(accessToken: string): Promise<string[]> {
    const response = await this.fetch(`https://googleads.googleapis.com/${this.version}/customers:listAccessibleCustomers`, {
      method: 'GET',
      headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
    });
    const json = (await response.json().catch(() => null)) as unknown;
    if (!response.ok) throw new GoogleAdsHttpError(response.status, isRecord(json) ? json : null);
    if (!isRecord(json)) throw new AdPlatformError('transient', 'BAD_STREAM');
    const ids: string[] = [];
    for (const name of Array.isArray(json.resourceNames) ? json.resourceNames : []) {
      const id = typeof name === 'string' ? /^customers\/(\d{10})$/.exec(name)?.[1] : undefined;
      if (id) ids.push(id);
    }
    return ids.slice(0, MAX_ACCOUNTS);
  }

  // One GAQL query as a stream: one request, one operation however many batches the answer has (a read). The query is text this file builds.
  // An ok answer must be a JSON array of batch objects with no trailing `{error}` element, or the sync would take a cut-off stream as zero rows and
  // wipe stored figures for the window.
  async search(accessToken: string, customerId: string, query: string): Promise<Array<Record<string, unknown>>> {
    if (!GOOGLE_CUSTOMER_ID.test(customerId)) throw new AdPlatformError('bad_request', 'BAD_ACCOUNT');
    const response = await this.fetch(`https://googleads.googleapis.com/${this.version}/customers/${customerId}/googleAds:searchStream`, {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ query }),
    });
    const json = (await response.json().catch(() => null)) as unknown;
    if (!response.ok) throw new GoogleAdsHttpError(response.status, isRecord(json) ? json : Array.isArray(json) && isRecord(json[0]) ? json[0] : null);
    if (!Array.isArray(json) || !json.every(isRecord)) throw new AdPlatformError('transient', 'BAD_STREAM');
    // The stream is a list of batches, each with its rows (REST answers one JSON array). A mid-stream failure arrives as a batch with `error`.
    const rows: Array<Record<string, unknown>> = [];
    for (const batch of json) {
      if (batch.error !== undefined && batch.error !== null) {
        const status = isRecord(batch.error) && typeof batch.error.code === 'number' ? batch.error.code : 500;
        throw new GoogleAdsHttpError(status, batch);
      }
      if (batch.results === undefined) continue;
      if (!Array.isArray(batch.results) || !batch.results.every(isRecord)) throw new AdPlatformError('transient', 'BAD_STREAM');
      for (const row of batch.results) rows.push(row);
    }
    return rows;
  }
}

// The account's own facts, one row: its name, currency and time zone, and whether it can be read (not a manager, and enabled).
const ACCOUNT_QUERY = 'SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone, customer.manager, customer.status FROM customer';
const accountDay = (from: string, to: string): string => `WHERE segments.date BETWEEN '${from}' AND '${to}'`;
const METRICS = 'metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions';
const customerQuery = (from: string, to: string): string => `SELECT segments.date, ${METRICS} FROM customer ${accountDay(from, to)}`;
const campaignQuery = (from: string, to: string): string => `SELECT campaign.id, campaign.name, segments.date, ${METRICS} FROM campaign ${accountDay(from, to)}`;

type Json = Record<string, unknown>;
const objectOf = (value: unknown): Json => (value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {});

// Money as Google reports it: micros of the currency unit, an int64 (a string in JSON), as a decimal string with up to six places. Exact: no float.
export function microsToDecimal(value: unknown): string | null {
  const text = typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? String(value) : typeof value === 'string' ? value : '';
  if (!/^\d{1,18}$/.test(text)) return null;
  const micros = BigInt(text);
  const whole = micros / 1_000_000n;
  const fraction = (micros % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : String(whole);
}

function countOf(value: unknown): number | null {
  const text = typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? String(value) : typeof value === 'string' ? value : '';
  return /^\d{1,15}$/.test(text) ? Number(text) : null;
}

// The account's conversions for the day: a double in JSON, as a decimal string of up to four places, left out when there are none.
function conversionsOf(value: unknown): Record<string, string> {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return {};
  const text = value.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
  return text === '0' || text === '' ? {} : { conversion: text };
}

function rowOf(result: Json, level: 'account' | 'campaign', accountId: string): AdDailyRow | null {
  const segments = objectOf(result.segments);
  const metrics = objectOf(result.metrics);
  const day = typeof segments.date === 'string' && DAY.test(segments.date) ? segments.date : null;
  // An absent metric counts as 0 (not a dropped row), while a present malformed value still drops the row.
  const spend = microsToDecimal(metrics.costMicros ?? 0);
  const impressions = countOf(metrics.impressions ?? 0);
  const clicks = countOf(metrics.clicks ?? 0);
  if (day === null || spend === null || impressions === null || clicks === null) return null;
  const campaign = objectOf(result.campaign);
  const campaignId = typeof campaign.id === 'string' && /^\d{1,20}$/.test(campaign.id) ? campaign.id : null;
  if (level === 'campaign' && campaignId === null) return null;
  return {
    level,
    externalObjectId: level === 'account' ? accountId : (campaignId as string),
    objectName: level === 'account' ? '' : typeof campaign.name === 'string' ? campaign.name.slice(0, 300) : '',
    day,
    spend,
    impressions,
    clicks,
    // Google reports no reach for these metrics.
    reach: null,
    results: conversionsOf(metrics.conversions),
  };
}

// The accounts a signed-in person can read: not a manager account (it has no figures of its own) and not one that is cancelled or suspended. A
// per-account failure other than a refused token or a rate limit is skipped so one unreadable account in `listAccessibleCustomers` does not break
// the rest; if the only accounts reached are manager accounts, `MANAGER_ACCOUNT_UNSUPPORTED` is raised.
async function readableAccounts(client: GoogleAdsClient, accessToken: string, onlyIds?: readonly string[]): Promise<AdPlatformAccount[]> {
  const out: AdPlatformAccount[] = [];
  let sawManager = false;
  for (const id of onlyIds ?? (await client.listAccessible(accessToken))) {
    let rows: Json[];
    try {
      rows = await client.search(accessToken, id, ACCOUNT_QUERY);
    } catch (error) {
      const mapped = googleAdsError(error);
      if (mapped.kind === 'token_expired' || mapped.kind === 'rate_limited') throw error;
      continue;
    }
    const customer = objectOf(rows[0]?.customer);
    if (customer.manager === true) {
      sawManager = true;
      continue;
    }
    const currency = customer.currencyCode;
    const timeZone = customer.timeZone;
    if (customer.status !== 'ENABLED') continue;
    if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency) || typeof timeZone !== 'string' || !timeZone) continue;
    const name = typeof customer.descriptiveName === 'string' && customer.descriptiveName.trim() ? customer.descriptiveName.trim().slice(0, 200) : `Google Ads account ${id}`;
    out.push({ externalAccountId: id, displayName: name, currency, timeZone });
  }
  if (out.length === 0 && sawManager) throw new AdPlatformError('permission', 'MANAGER_ACCOUNT_UNSUPPORTED');
  return out;
}

export interface GoogleAdsPlatformOptions extends GoogleAdsAppConfig {
  fetch?: Fetch;
  now?: () => Date;
  version?: string;
}

// The accounts a refresh token reaches, and the daily figures of one: every request is a read and the token never leaves here.
export class GoogleAdsPlatform implements AdPlatform {
  readonly id = GOOGLE_ADS_PROVIDER;
  readonly hosts = GOOGLE_ADS_HOSTS;
  readonly capabilities = GOOGLE_CAPABILITIES;
  private readonly client: GoogleAdsClient;
  private readonly now: () => Date;

  constructor(options: GoogleAdsPlatformOptions) {
    this.client = new GoogleAdsClient(options, options.fetch, options.version);
    this.now = options.now ?? (() => new Date());
  }

  async accounts(secret: string, externalAccountId?: string): Promise<AdPlatformAccount[]> {
    const { refreshToken } = parseSecret(secret);
    if (externalAccountId !== undefined && !GOOGLE_CUSTOMER_ID.test(externalAccountId)) throw new AdPlatformError('bad_request', 'BAD_ACCOUNT');
    try {
      return await readableAccounts(this.client, await this.client.accessToken(refreshToken), externalAccountId ? [externalAccountId] : undefined);
    } catch (error) {
      throw googleAdsError(error, this.now);
    }
  }

  async readDaily(secret: string, externalAccountId: string, range: { from: string; to: string }): Promise<AdDailyRow[]> {
    const { refreshToken } = parseSecret(secret);
    if (!GOOGLE_CUSTOMER_ID.test(externalAccountId) || !DAY.test(range.from) || !DAY.test(range.to) || range.from > range.to) throw new AdPlatformError('bad_request', 'BAD_RANGE');
    try {
      const accessToken = await this.client.accessToken(refreshToken);
      // Account level first, then campaign level: the same days, each as its own rows.
      const account = (await this.client.search(accessToken, externalAccountId, customerQuery(range.from, range.to))).map((r) => rowOf(r, 'account', externalAccountId));
      const campaign = (await this.client.search(accessToken, externalAccountId, campaignQuery(range.from, range.to))).map((r) => rowOf(r, 'campaign', externalAccountId));
      return [...account, ...campaign].filter((r): r is AdDailyRow => r !== null);
    } catch (error) {
      throw googleAdsError(error, this.now);
    }
  }
}

function connectorError(error: unknown, codeStep = false): ConnectorError {
  if (error instanceof ConnectorError) return error;
  if (error instanceof AdPlatformError) {
    if (error.kind === 'permission') return new ConnectorError('denied', 'Google refused the request', error.code);
    return new ConnectorError('provider', 'Google could not be read', error.code ?? error.kind);
  }
  if (error instanceof GoogleAdsHttpError) {
    if (codeStep && error.oauth === 'invalid_grant') return new ConnectorError('invalid_grant', 'Google refused the authorization code', 'invalid_grant');
    const code = safeCode(error.code ?? error.oauth ?? error.statusWord) ?? String(error.status);
    return new ConnectorError(error.status === 403 || error.status === 429 ? 'denied' : 'provider', 'Google refused the request', code);
  }
  return new ConnectorError('provider', 'Google could not be reached');
}

// Google's consent screen for the Ads scope, with offline access so a refresh token comes back, and the accounts the person can read: the OAuth
// connector of the channel layer for a Google Ads account. The person's refresh token never leaves here; each account's connection seals the same one.
export class GoogleAdsConnector implements OAuthConnector {
  readonly provider = GOOGLE_ADS_PROVIDER;
  readonly pkce = true;
  private readonly client: GoogleAdsClient;

  private readonly now: () => Date;

  constructor(app: GoogleAdsAppConfig, options: { fetch?: Fetch; version?: string; now?: () => Date } = {}) {
    this.client = new GoogleAdsClient(app, options.fetch, options.version);
    this.now = options.now ?? (() => new Date());
  }

  authorizeUrl(input: AuthorizeInput): string {
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.searchParams.set('client_id', this.client.clientId);
    url.searchParams.set('redirect_uri', input.redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', GOOGLE_ADS_SCOPES.join(' '));
    url.searchParams.set('state', input.state);
    // Offline access with consent each time, so Google returns a refresh token even for an account connected before.
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('prompt', 'consent');
    url.searchParams.set('include_granted_scopes', 'false');
    if (input.codeChallenge) {
      url.searchParams.set('code_challenge', input.codeChallenge);
      url.searchParams.set('code_challenge_method', 'S256');
    }
    return url.toString();
  }

  async exchange(input: ExchangeInput): Promise<ConnectedAccount[]> {
    const answer = await this.client.token({ grant_type: 'authorization_code', code: input.code, redirect_uri: input.redirectUri, ...(input.codeVerifier ? { code_verifier: input.codeVerifier } : {}) }).catch((error: unknown) => {
      throw connectorError(error, true);
    });
    if (typeof answer.access_token !== 'string' || !answer.access_token) throw new ConnectorError('provider', 'Google answered without an access token');
    if (typeof answer.refresh_token !== 'string' || !answer.refresh_token) throw new ConnectorError('provider', 'Google answered without a refresh token');
    const granted = typeof answer.scope === 'string' ? answer.scope.split(' ').filter(Boolean) : [];
    if (!GOOGLE_ADS_SCOPES.every((s) => granted.includes(s))) throw new ConnectorError('denied', 'Google did not grant the Google Ads permission', 'MISSING_PERMISSION');
    const accounts = await readableAccounts(this.client, answer.access_token).catch((error: unknown) => {
      throw connectorError(googleAdsError(error));
    });
    const secret = JSON.stringify({ refreshToken: answer.refresh_token } satisfies GoogleAdsSecret);
    // A refresh token ends when the person revokes it or after six months unused, with no date to know; but one issued to a consent screen left in
    // Testing lasts 7 days, and Google then says so in the answer (`refresh_token_expires_in`, in seconds) [U: the answer's field is not on the pages
    // read, so it is used only when present]. That date is the connection's own, so the Ads screen can warn before it lapses and the sync marks the
    // connection expired on it; without it there is no date, and the sync learns of an end from Google's answer (invalid_grant).
    const seconds = Number(answer.refresh_token_expires_in);
    const expiresAt = Number.isFinite(seconds) && seconds > 0 && seconds <= 366 * 86_400 ? new Date(this.now().getTime() + seconds * 1000) : null;
    return accounts.map((a) => ({ provider: GOOGLE_ADS_PROVIDER, externalAccountId: a.externalAccountId, displayName: a.displayName, scopes: [...granted], expiresAt, secret }));
  }
}

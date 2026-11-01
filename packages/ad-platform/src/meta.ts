// SPDX-License-Identifier: AGPL-3.0-only
// Meta ads (Facebook and Instagram), read only (ADR-0040, plan docs/plan/ads.md sections 4 and 5, slice A2), written from
// Meta's Marketing API docs. One Meta app serves a deployment (CHANNEL_META_ADS_APP_ID and CHANNEL_META_ADS_APP_SECRET; the
// same app as the Pages one is fine, a classic app holds both). The connection is one channel connection per ad account
// (ADR-0025): Facebook Login with `ads_read` alone, the short-lived user token becomes a long-lived one (about 60 days,
// no refresh: a new login is needed), `/me/adaccounts` lists the ad accounts the user granted, and each account is
// connected with the same token sealed for it. The sync then reads the Insights edge of one account with GET requests
// only: nothing here calls a Graph endpoint that creates or changes anything, and the platform class below has no
// method that could (a test pins that its source names no write and that every call it makes is a GET).
//
// Access tier. The Marketing API gives an app the "Limited" tier (Meta's May 2026 name for what the docs also call
// Standard access or the development tier) until App Review moves it to "Full". The owner's own ad accounts are readable
// on the Limited tier with `ads_read` [C]; its rate limits are low [C] (plan section 5.3), so a run reads each account
// with a handful of calls, backs off for the time a rate limit names, and the app never retries in a loop.
import type { AuthorizeInput, ConnectedAccount, ExchangeInput, Fetch, MetaAppConfig, OAuthConnector } from '@crove/channel';
import { ConnectorError, Graph, GraphError, MetaLogin, META_DEFAULT_GRAPH_VERSION, META_GRAPH_HOST, asProviderError } from '@crove/channel';
import { AdPlatformError, type AdDailyRow, type AdPlatform, type AdPlatformAccount, type AdPlatformCapabilities } from './index.ts';

// Reading reports is all the ads module does; Meta's ads_read is "read reports of ad accounts you own or were granted".
export const META_ADS_SCOPES = ['ads_read'] as const;
export const META_ADS_PROVIDER = 'meta_ads' as const;
// Permissions that let a token change campaigns, budgets or the business: a connection that holds one is refused.
export const META_FORBIDDEN_SCOPES: readonly string[] = ['ads_management', 'business_management'];

// Insights stop changing after 28 days (plan section 5.2): a day older than that is settled.
const META_REVISION_DAYS = 28;
// A result is an action type of the day's `actions`, one list per row. These are the types an owner may pick, and the
// Meta action types each sums [U: Meta's action_type names for purchases and conversations are read from its docs, not
// from a live account, so the live check (docs/runbooks/ads-live-check.md) confirms them].
const RESULT_ACTIONS: Readonly<Record<string, readonly string[]>> = {
  purchase: ['omni_purchase'],
  lead: ['lead'],
  message: ['onsite_conversion.messaging_conversation_started_7d'],
};
const META_CAPABILITIES: AdPlatformCapabilities = { revisionDays: META_REVISION_DAYS, resultKinds: Object.keys(RESULT_ACTIONS) };

// The fields of the Insights read: the day's money and counts, and the actions the results come from.
const INSIGHT_FIELDS = 'date_start,spend,impressions,clicks,reach,actions,campaign_id,campaign_name';
const ACCOUNT_FIELDS = 'id,name,currency,timezone_name';
const ACT_ID = /^act_\d{1,32}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_ACCOUNTS_LISTED = 1000;
const PAGE_LIMIT = '500';
// One read of a window is a few pages at most (a window is at most 31 days); a loop that runs on is an answer to refuse.
const MAX_PAGES = 100;
// How long a limit holds an account back when Meta's answer does not say: error codes 17 and 613 are the score cap of the
// tier (a block of a few minutes, plan section 5.3), the others an hourly limit [C]. The Graph client does not hand back
// the usage headers, so the delay is a fixed one per code [U on the exact times].
const SCORE_CAP_DELAY_MS = 10 * 60_000;
const HOURLY_DELAY_MS = 60 * 60_000;

interface AccountsAnswer {
  data?: Array<{ id?: unknown; name?: unknown; currency?: unknown; timezone_name?: unknown; account_status?: unknown }>;
  paging?: { cursors?: { after?: unknown }; next?: unknown };
}
interface InsightRow {
  date_start?: unknown;
  spend?: unknown;
  impressions?: unknown;
  clicks?: unknown;
  reach?: unknown;
  actions?: unknown;
  campaign_id?: unknown;
  campaign_name?: unknown;
}
interface InsightsAnswer {
  data?: InsightRow[];
  paging?: { cursors?: { after?: unknown }; next?: unknown };
}

interface MetaSecret {
  accessToken: string;
}

function parseSecret(secret: string): MetaSecret {
  let parsed: unknown;
  try {
    parsed = JSON.parse(secret);
  } catch {
    throw new AdPlatformError('token_expired', 'BAD_SECRET');
  }
  const token = (parsed as { accessToken?: unknown } | null)?.accessToken;
  if (typeof token !== 'string' || !token) throw new AdPlatformError('token_expired', 'BAD_SECRET');
  return { accessToken: token };
}

// A Graph failure as the channel layer types an error (plan section 5.3). Only the platform's code is kept, never its message.
export function metaAdsError(error: unknown, now: () => Date = () => new Date()): AdPlatformError {
  if (error instanceof AdPlatformError) return error;
  if (error instanceof GraphError) {
    const code = error.code;
    const text = String(code ?? error.status);
    // A refused or expired token (190), a session that ended (102) or a token Meta invalidated (458 to 467 subcodes).
    if (code === 190 || code === 102 || error.subcode === 458 || error.subcode === 460 || error.subcode === 463 || error.subcode === 467) return new AdPlatformError('token_expired', text);
    // The app-level Insights throttle (4), the score cap of the tier (17, 613, 32) and the per-ad-account limits (80000
    // series): wait for the time the limit holds, then read again.
    if (code === 4 || code === 17 || code === 32 || code === 613) return new AdPlatformError('rate_limited', text, new Date(now().getTime() + (code === 4 ? HOURLY_DELAY_MS : SCORE_CAP_DELAY_MS)));
    if (code === 80000 || code === 80003 || code === 80004 || code === 80014) return new AdPlatformError('rate_limited', text, new Date(now().getTime() + HOURLY_DELAY_MS));
    // A missing permission or an account the grant does not reach.
    if (code === 10 || code === 3 || (code !== undefined && code >= 200 && code <= 299) || error.status === 403) return new AdPlatformError('permission', text);
    // Meta's own failure, or a call that may pass on a retry.
    if (code === 1 || code === 2 || error.status >= 500) return new AdPlatformError('transient', text);
    if (code === 100 || code === 3018 || error.status === 400) return new AdPlatformError('bad_request', text);
    return new AdPlatformError('unknown', text);
  }
  // fetch's own failure (DNS, TLS, a timeout or an abort): worth another try later. Anything else is not a network error.
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError' || (error instanceof TypeError && /fetch failed/i.test(error.message)))) return new AdPlatformError('transient', 'NETWORK');
  return new AdPlatformError('unknown');
}

// A decimal string of a platform's number, cut to `decimals` places, or null when it is not a non-negative decimal.
function decimalOf(value: unknown, decimals: number): string | null {
  if (typeof value !== 'string' || !/^\d{1,16}(\.\d+)?$/.test(value)) return null;
  const [whole, fraction = ''] = value.split('.') as [string, string?];
  const kept = fraction.slice(0, decimals).replace(/0+$/, '');
  return kept ? `${whole}.${kept}` : whole;
}

function countOf(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d{1,15}$/.test(value)) return null;
  return Number(value);
}

// The results of a row: each result kind the owner may pick, summed over the Meta action types it stands for. A kind
// the day has no action for is left out, so a day with no result shows no cost per result.
function resultsOf(actions: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!Array.isArray(actions)) return out;
  for (const [kind, types] of Object.entries(RESULT_ACTIONS)) {
    let total = 0;
    let seen = false;
    for (const action of actions as Array<{ action_type?: unknown; value?: unknown }>) {
      if (typeof action.action_type !== 'string' || !types.includes(action.action_type)) continue;
      const n = decimalOf(action.value, 0);
      if (n === null) continue;
      total += Number(n);
      seen = true;
    }
    if (seen && total > 0) out[kind] = String(total);
  }
  return out;
}

// The fetch of this adapter and of its OAuth connection: it reaches graph.facebook.com over https and nothing else. The shared
// Graph client also knows Meta's video and upload hosts (for publishing), which an ads reader never needs, so this narrows it
// to the one host the plan names (section 7.6); a request to any other host, a plain http one, or one with credentials in the
// address is refused before it leaves, and nothing redirects (the channel layer's allowlisted fetch follows no redirect).
export function graphHostOnly(fetchImpl?: Fetch): Fetch {
  const send: Fetch = fetchImpl ?? ((input, init) => fetch(input, init));
  return async (input, init) => {
    let url: URL;
    try {
      url = new URL(input);
    } catch {
      throw new AdPlatformError('unknown', 'HOST_NOT_ALLOWED');
    }
    if (url.protocol !== 'https:' || url.host !== META_GRAPH_HOST || url.username !== '' || url.password !== '') throw new AdPlatformError('unknown', 'HOST_NOT_ALLOWED');
    return send(input, init);
  };
}

export interface MetaAdsPlatformOptions {
  appSecret: string;
  graphVersion?: string;
  fetch?: Fetch;
  now?: () => Date;
}

// The ad accounts a Meta token reaches, and the daily Insights of one. Every request is a GET to graph.facebook.com made
// by the shared Graph client: the token travels in the Authorization header, with appsecret_proof, and never in a URL.
export class MetaAdsPlatform implements AdPlatform {
  readonly id = META_ADS_PROVIDER;
  readonly hosts = [META_GRAPH_HOST] as const;
  readonly capabilities = META_CAPABILITIES;
  private readonly graph: Graph;
  private readonly now: () => Date;

  constructor(options: MetaAdsPlatformOptions) {
    this.graph = new Graph(options.appSecret, options.graphVersion ?? META_DEFAULT_GRAPH_VERSION, graphHostOnly(options.fetch));
    this.now = options.now ?? (() => new Date());
  }

  async accounts(secret: string): Promise<AdPlatformAccount[]> {
    const { accessToken } = parseSecret(secret);
    try {
      const out: AdPlatformAccount[] = [];
      for (const row of await listAdAccounts(this.graph, accessToken)) {
        if (typeof row.id !== 'string' || !ACT_ID.test(row.id) || typeof row.currency !== 'string' || !/^[A-Z]{3}$/.test(row.currency) || typeof row.timezone_name !== 'string' || !row.timezone_name) continue;
        out.push({ externalAccountId: row.id, displayName: accountName(row.name, row.id), currency: row.currency, timeZone: row.timezone_name });
      }
      return out;
    } catch (error) {
      throw metaAdsError(error, this.now);
    }
  }

  async readDaily(secret: string, externalAccountId: string, range: { from: string; to: string }): Promise<AdDailyRow[]> {
    const { accessToken } = parseSecret(secret);
    if (!ACT_ID.test(externalAccountId) || !DAY.test(range.from) || !DAY.test(range.to) || range.from > range.to) throw new AdPlatformError('bad_request', 'BAD_RANGE');
    try {
      // Account level first, then campaign level: the same days, each as its own rows.
      const accountRows = await this.insights(accessToken, externalAccountId, range, 'account');
      const campaignRows = await this.insights(accessToken, externalAccountId, range, 'campaign');
      return [...accountRows, ...campaignRows];
    } catch (error) {
      throw metaAdsError(error, this.now);
    }
  }

  // One level of the Insights edge, one row per object and day (time_increment=1), by cursor.
  private async insights(token: string, accountId: string, range: { from: string; to: string }, level: 'account' | 'campaign'): Promise<AdDailyRow[]> {
    const out: AdDailyRow[] = [];
    let after: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const params: Record<string, string> = {
        level,
        time_increment: '1',
        time_range: JSON.stringify({ since: range.from, until: range.to }),
        fields: INSIGHT_FIELDS,
        limit: PAGE_LIMIT,
      };
      if (after) params.after = after;
      const answer = await this.graph.call<InsightsAnswer>('GET', `${accountId}/insights`, { token, params });
      for (const row of answer.data ?? []) {
        const mapped = rowOf(row, level, accountId);
        if (mapped) out.push(mapped);
      }
      const cursor = answer.paging?.cursors?.after;
      if ((answer.data ?? []).length === 0 || typeof answer.paging?.next !== 'string' || typeof cursor !== 'string') return out;
      after = cursor;
    }
    throw new AdPlatformError('unknown', 'TOO_MANY_PAGES');
  }
}

const accountName = (name: unknown, id: string): string => (typeof name === 'string' && name.trim() ? name.trim().slice(0, 200) : `Meta ad account ${id}`);

async function listAdAccounts(graph: Graph, token: string): Promise<NonNullable<AccountsAnswer['data']>> {
  const out: NonNullable<AccountsAnswer['data']> = [];
  let after: string | null = null;
  while (out.length < MAX_ACCOUNTS_LISTED) {
    const params: Record<string, string> = { fields: ACCOUNT_FIELDS, limit: '100' };
    if (after) params.after = after;
    const page = await graph.call<AccountsAnswer>('GET', 'me/adaccounts', { token, params });
    const rows = page.data ?? [];
    out.push(...rows);
    const cursor = page.paging?.cursors?.after;
    if (rows.length === 0 || typeof page.paging?.next !== 'string' || typeof cursor !== 'string') break;
    after = cursor;
  }
  return out;
}

// One Insights row as an ad row, or null for a row that is not a day of this level (the sync command checks the rest
// again).
function rowOf(row: InsightRow, level: 'account' | 'campaign', accountId: string): AdDailyRow | null {
  if (typeof row.date_start !== 'string' || !DAY.test(row.date_start)) return null;
  const spend = decimalOf(row.spend, 6);
  const impressions = countOf(row.impressions);
  const clicks = countOf(row.clicks);
  if (spend === null || impressions === null || clicks === null) return null;
  const reach = row.reach === undefined ? null : countOf(row.reach);
  const campaignId = typeof row.campaign_id === 'string' && row.campaign_id ? row.campaign_id : null;
  if (level === 'campaign' && campaignId === null) return null;
  return {
    level,
    externalObjectId: level === 'account' ? accountId : (campaignId as string),
    objectName: level === 'account' ? '' : typeof row.campaign_name === 'string' ? row.campaign_name.slice(0, 300) : '',
    day: row.date_start,
    spend,
    impressions,
    clicks,
    reach,
    results: resultsOf(row.actions),
  };
}

// Facebook Login for the ads_read permission, and the ad accounts the user granted: the OAuth connector of the channel layer
// for a Meta ad account (ADR-0025, plan section 5.1). The user token never leaves here; each account's connection seals the
// same long-lived token, which the sync reads with.
export class MetaAdsConnector implements OAuthConnector {
  readonly provider = META_ADS_PROVIDER;
  readonly pkce = false;
  private readonly login: MetaLogin;
  private readonly now: () => Date;

  constructor(app: MetaAppConfig, options: { fetch?: Fetch; now?: () => Date } = {}) {
    this.login = new MetaLogin(app, META_ADS_SCOPES, graphHostOnly(options.fetch));
    this.now = options.now ?? (() => new Date());
  }

  authorizeUrl(input: AuthorizeInput): string {
    return this.login.authorizeUrl(input);
  }

  async exchange(input: ExchangeInput): Promise<ConnectedAccount[]> {
    // The connection records every permission the token holds, not only ads_read: a Meta user token carries all that the
    // person ever granted this app, so with an app shared with Pages publishing it can also post to their Pages (plan section
    // 8, R1). A separate ads app keeps it to ads_read; the runbook and the config say so.
    const { token, granted } = await this.login.userToken(input);
    const scopes = granted;
    // A token that can change campaigns or the business is refused: this connection reads reports, and a leaked token must not
    // be able to spend. Pages permissions (pages_*, publish_*) are accepted and shown on the Ads screen.
    if (granted.some((s) => META_FORBIDDEN_SCOPES.includes(s))) throw new ConnectorError('denied', `the token holds ${granted.filter((s) => META_FORBIDDEN_SCOPES.includes(s)).join(', ')}`, 'WRITE_PERMISSION_GRANTED');
    let rows: NonNullable<AccountsAnswer['data']>;
    try {
      rows = await listAdAccounts(this.login.graph, token);
    } catch (error) {
      throw asProviderError(error);
    }
    // A long-lived user token lasts about 60 days and cannot be refreshed [C]: the connection expires on that date and the
    // owner connects again; the sync also learns it from Meta's answer (code 190).
    const expiresAt = new Date(this.now().getTime() + 60 * 86_400_000);
    const accounts: ConnectedAccount[] = [];
    for (const row of rows) {
      if (typeof row.id !== 'string' || !ACT_ID.test(row.id)) continue;
      accounts.push({ provider: META_ADS_PROVIDER, externalAccountId: row.id, displayName: accountName(row.name, row.id), scopes: [...scopes], expiresAt, secret: JSON.stringify({ accessToken: token } satisfies MetaSecret) });
    }
    // A login that reaches no ad account is not a missing permission: the caller says so in words of its own.
    return accounts;
  }
}

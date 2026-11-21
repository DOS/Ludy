// SPDX-License-Identifier: AGPL-3.0-only
// The TikTok Shop token API (#2524, T1 = #4256; design https://github.com/DOS/Ludy/issues/2524#issuecomment-7059664269): the authorization code traded for a token pair (`createTiktokToken`, called once by the
// authorize step) and the refresh of a connection's tokens (`TiktokRefresher`, run by the worker's channel refresh sweep). DORMANT: nothing offers `tiktok_shop` until the live check (#2522). Built from the
// OFFICIAL pages read on 2026-11-21 (partner.tiktokshop.com/docv2/page/authorization-overview-202407 and common-errors):
//   - both calls are a GET on `https://auth.tiktok-shops.com/api/v2/token/get` and `.../token/refresh` with the parameters IN THE QUERY, the app secret included (`grant_type` is `authorized_code` for a
//     create, a word that is intentional, and `refresh_token` for a refresh);
//   - the answer: `code` 0, `data.access_token`, `access_token_expire_in` (a Unix time in seconds; 7 days by default), `refresh_token`, `refresh_token_expire_in` (a Unix time: "equals the authorization
//     duration the user granted"), `open_id`, `seller_base_region`, `user_type`, `granted_scopes`;
//   - an authorization code lives 30 minutes and works once; a bad, used or expired one is 36004004.
// Not confirmed, for the live check: whether the refresh answer changes the refresh token (the whole answer is re-sealed either way), the code a dead refresh token gets (none is documented, so a refused
// refresh is recognised only locally, by the dates, and every other trouble is a failure tried again at the next sweep, at most every six hours), and the real lifetimes.
//
// THE SECRET IN THE ADDRESS. A GET puts the app secret and the code or the refresh token in the URL, so the URL is built in ONE function (`getToken`), handed only to the host-bound fetch and never kept,
// logged or put in an error: every failure of the call ends as a short closed word ("NETWORK", "BAD_ANSWER", an HTTP status or a documented code), never the error object, the URL or TikTok's text (a fetch
// error can carry the address). The sealed secret is the JSON of the connection; only the worker opens it.
//
// One call, to one host, never repeated: a call that was sent and whose answer was lost may already have spent the refresh token or the single-use code, so asking again could not help and a refusal would
// then expire a connection that was fine. A lost answer ends as the seller authorizing again.
import type { Refresher } from '@crove/channel';
import { readCappedAnswer, type Fetch } from './marketplace-adapter-kit.ts';

export const TIKTOK_AUTH_HOST = 'auth.tiktok-shops.com';
export const TIKTOK_TOKEN_HOSTS: readonly string[] = [TIKTOK_AUTH_HOST];
const GET_PATH = '/api/v2/token/get';
const REFRESH_PATH = '/api/v2/token/refresh';

// An access token lasts 7 days: it is renewed when under one day is left (channel_refresh_due caps the window at seven days), and a connection whose access life is not longer than the horizon is renewed
// at most this often while its stored access token is still valid, so a short life does not rotate the pair at every ten-minute sweep (an expired one is renewed at once).
export const TIKTOK_REFRESH_HORIZON_SECONDS = 86_400;
const MIN_REFRESH_GAP_MS = 6 * 3_600_000;
const MAX_ANSWER_BYTES = 64_000;
// An expiry that is not a plausible Unix time within these bounds is not taken: the access life then falls back to one day (the connection is due again after the minimum gap and takes the answer after), so a
// good pair is never thrown away over a field.
const MAX_AHEAD_S = 400 * 86_400;
const FALLBACK_LIFETIME_S = 86_400;
// The documented user_type of a seller (0). The other values are creators, partners and global selling sellers: not what a Vietnam seller connection is.
const SELLER_USER_TYPE = 0;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const token = (v: unknown): v is string => typeof v === 'string' && v.length >= 1 && v.length <= 400 && v === v.trim() && /^[\x21-\x7e]+$/.test(v);
// A code as it may be reported: TikTok's own numeric codes or the `HTTP_<status>` this module makes for an answer that has none; every other text is `otherwise`, so nothing the host sends as a "code" is passed on.
const safeCode = (code: string, otherwise: string): string => (/^(\d{1,10}|HTTP_\d{3})$/.test(code) ? code : otherwise);
// An expiry as an answer writes it: a Unix time in seconds, a number or digits, between now and 400 days ahead; anything else is null.
const unixExpiry = (v: unknown, nowMs: number): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d{9,11}$/.test(v) ? Number(v) : Number.NaN;
  const ms = n * 1000;
  return Number.isFinite(n) && ms > nowMs && ms <= nowMs + MAX_AHEAD_S * 1000 ? ms : null;
};

// The documented code of a bad, used or expired authorization code ("Invalid auth code", common-errors).
const BAD_AUTH_CODE = '36004004';
// No code is documented for a dead refresh token (the page lists none), so none is invented here: a refresh is refused only by the dates, locally, and anything else is a failure. The live check fills this.
const REFRESH_REFUSED_CODES: ReadonlySet<string> = new Set<string>();

interface Called {
  // The answer as a record, with `code` as text.
  answer: Record<string, unknown>;
  code: string;
}
interface Troubled {
  failed: string;
}

// The one place a token URL exists. A GET, no body, no redirect (the bound fetch), the answer capped.
async function getToken(fetchImpl: Fetch, path: string, params: Record<string, string>): Promise<Called | Troubled> {
  let response: Response;
  try {
    response = await fetchImpl(`https://${TIKTOK_AUTH_HOST}${path}?${new URLSearchParams(params).toString()}`, { method: 'GET', headers: { accept: 'application/json' } });
  } catch {
    return { failed: 'NETWORK' };
  }
  try {
    if (response.status === 429 || response.status >= 500) {
      await response.body?.cancel().catch(() => undefined);
      return { failed: String(response.status) };
    }
    const answer: unknown = JSON.parse(await readCappedAnswer(response, () => new Error('too large'), MAX_ANSWER_BYTES));
    if (!isRecord(answer)) return { failed: 'BAD_ANSWER' };
    const code = typeof answer.code === 'number' || typeof answer.code === 'string' ? String(answer.code) : '';
    // A success is a 2xx answer whose code is 0; any other answer carries its own code (or HTTP_<status> when it has none).
    if (response.ok && code === '0') return { answer, code };
    return { answer, code: code === '' || code === '0' ? `HTTP_${response.status}` : code };
  } catch {
    return { failed: 'BAD_ANSWER' };
  }
}

interface Tokens {
  accessToken: string;
  refreshToken: string;
  accessExpiresAtMs: number;
  // The end of the seller's authorization as the answer implies it (the refresh token's own end), or null.
  refreshExpiresAtMs: number | null;
  openId: string | null;
  region: string | null;
  userType: number | null;
  scopes: string[];
}

// The pair of a good answer: both tokens usable, the access end as given or one day from now, the authorization end when the answer says it. The account's name (`seller_name`) is not kept.
function tokensOf(data: unknown, nowMs: number): Tokens | null {
  if (!isRecord(data) || !token(data.access_token) || !token(data.refresh_token)) return null;
  const accessEnd = unixExpiry(data.access_token_expire_in, nowMs);
  const scopes = Array.isArray(data.granted_scopes) ? data.granted_scopes.filter((s): s is string => typeof s === 'string' && /^[A-Za-z0-9_.&-]{1,60}$/.test(s)).slice(0, 60) : [];
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    accessExpiresAtMs: accessEnd ?? nowMs + FALLBACK_LIFETIME_S * 1000,
    refreshExpiresAtMs: unixExpiry(data.refresh_token_expire_in, nowMs),
    openId: typeof data.open_id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(data.open_id) ? data.open_id : null,
    region: typeof data.seller_base_region === 'string' && /^[A-Z]{2}$/.test(data.seller_base_region) ? data.seller_base_region : null,
    userType: typeof data.user_type === 'number' && Number.isInteger(data.user_type) ? data.user_type : null,
    scopes,
  };
}

export interface TiktokTokenOptions {
  // Bound to TIKTOK_TOKEN_HOSTS by the caller (hostBoundFetch); nothing here uses another.
  fetch: Fetch;
  now?: () => Date;
}

// What the authorize step gets: the sealed secret of the connection (the app key and secret, the new pair and their dates), the access end (the channel connection's `expiresAt`, so the sweep picks it up) and
// the end of the seller's authorization (the date a person must authorize again by).
export interface TiktokGrant {
  secret: string;
  accessExpiresAt: Date;
  authorizationEndsAt: Date | null;
  region: string | null;
}

// Trades the single-use authorization code the seller's consent returned for the token pair. `refused`: TikTok says the code is bad, used or expired, or it is not a seller's; the seller must authorize
// again. `failed`: anything else. A code is single use, so a lost answer is never asked again either.
export async function createTiktokToken(options: TiktokTokenOptions, input: { appKey: string; appSecret: string; code: string }): Promise<TiktokGrant | { refused: string } | { failed: string }> {
  const now = (options.now ?? (() => new Date()))().getTime();
  if (!token(input.appKey) || !token(input.appSecret)) return { refused: 'BAD_SECRET' };
  if (!token(input.code)) return { refused: 'BAD_CODE' };
  const called = await getToken(options.fetch, GET_PATH, { app_key: input.appKey, app_secret: input.appSecret, auth_code: input.code, grant_type: 'authorized_code' });
  if ('failed' in called) return called;
  if (called.code !== '0') return called.code === BAD_AUTH_CODE ? { refused: BAD_AUTH_CODE } : { failed: safeCode(called.code, 'UNKNOWN') };
  const tokens = tokensOf(called.answer.data, now);
  if (!tokens) return { failed: 'BAD_ANSWER' };
  // A token of a creator or a partner is not a seller connection: refused, nothing sealed.
  if (tokens.userType !== SELLER_USER_TYPE) return { refused: 'USER_TYPE' };
  const accessExpiresAt = new Date(tokens.accessExpiresAtMs);
  const authorizationEndsAt = tokens.refreshExpiresAtMs === null ? null : new Date(tokens.refreshExpiresAtMs);
  const secret = JSON.stringify({
    appKey: input.appKey,
    appSecret: input.appSecret,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    accessExpiresAt: accessExpiresAt.toISOString(),
    ...(authorizationEndsAt ? { refreshExpiresAt: authorizationEndsAt.toISOString() } : {}),
    refreshedAt: new Date(now).toISOString(),
    ...(tokens.openId ? { openId: tokens.openId } : {}),
    ...(tokens.region ? { region: tokens.region } : {}),
    ...(tokens.scopes.length > 0 ? { scopes: tokens.scopes } : {}),
  });
  return { secret, accessExpiresAt, authorizationEndsAt, region: tokens.region };
}

export class TiktokRefresher implements Refresher {
  readonly provider = 'marketplace_tiktok_shop' as const;
  readonly horizonSeconds = TIKTOK_REFRESH_HORIZON_SECONDS;
  private readonly fetchImpl: Fetch;
  private readonly now: () => Date;

  constructor(options: TiktokTokenOptions) {
    this.fetchImpl = options.fetch;
    this.now = options.now ?? (() => new Date());
  }

  async refresh(secret: string): Promise<{ secret: string; expiresAt: Date } | { refused: string } | { failed: string }> {
    let old: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(secret);
      if (!isRecord(parsed)) return { refused: 'BAD_SECRET' };
      old = parsed;
    } catch {
      return { refused: 'BAD_SECRET' };
    }
    if (!token(old.appKey) || !token(old.appSecret)) return { refused: 'BAD_SECRET' };
    // The authorize step has not added the tokens, or the connection holds no refresh token: nothing to renew with, and it must be authorized again.
    if (!token(old.refreshToken)) return { refused: 'NO_REFRESH_TOKEN' };
    const now = this.now().getTime();
    const oldEnd = typeof old.refreshExpiresAt === 'string' ? Date.parse(old.refreshExpiresAt) : Number.NaN;
    // The seller's authorization ends at the refresh token's date and is never extended by a refresh: past it there is nothing to try, so no call is made (and none with a token known to be dead).
    if (!Number.isNaN(oldEnd) && oldEnd <= now) return { refused: 'AUTHORIZATION_ENDED' };
    // Renewed a moment ago and due again (a short access life): not asked again yet, so the pair is not rotated at every sweep. The gap never holds back a connection whose stored access token has already
    // expired: that one is renewed at once (an expired token is a connection that does not work).
    const lastAt = typeof old.refreshedAt === 'string' ? Date.parse(old.refreshedAt) : Number.NaN;
    const accessEnd = typeof old.accessExpiresAt === 'string' ? Date.parse(old.accessExpiresAt) : Number.NaN;
    const accessExpired = !Number.isNaN(accessEnd) && accessEnd <= now;
    if (!accessExpired && !Number.isNaN(lastAt) && now >= lastAt && now - lastAt < MIN_REFRESH_GAP_MS) return { failed: 'RECENT' };

    const called = await getToken(this.fetchImpl, REFRESH_PATH, { app_key: old.appKey, app_secret: old.appSecret, refresh_token: old.refreshToken, grant_type: 'refresh_token' });
    if ('failed' in called) return called;
    if (called.code !== '0') return REFRESH_REFUSED_CODES.has(called.code) ? { refused: called.code } : { failed: safeCode(called.code, 'UNKNOWN') };
    const tokens = tokensOf(called.answer.data, now);
    if (!tokens) return { failed: 'BAD_ANSWER' };

    // The access life restarts; the authorization end does not: the date kept is the earlier of the one we had and the one the answer implies, so no later date is ever believed. The scopes of the answer
    // replace the old ones when it lists any.
    const known = [oldEnd, tokens.refreshExpiresAtMs ?? Number.NaN].filter((v) => !Number.isNaN(v));
    const next: Record<string, unknown> = { ...old, accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, accessExpiresAt: new Date(tokens.accessExpiresAtMs).toISOString(), refreshedAt: new Date(now).toISOString() };
    if (known.length > 0) next.refreshExpiresAt = new Date(Math.min(...known)).toISOString();
    else delete next.refreshExpiresAt;
    if (tokens.scopes.length > 0) next.scopes = tokens.scopes;
    return { secret: JSON.stringify(next), expiresAt: new Date(tokens.accessExpiresAtMs) };
  }
}

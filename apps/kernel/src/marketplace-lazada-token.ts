// SPDX-License-Identifier: AGPL-3.0-only
// The Lazada token API (#2524, S3a = #4240; design https://github.com/DOS/Ludy/issues/4240#issuecomment-7057958649): the authorization code traded for a token pair (`createLazadaToken`, called once by the
// authorize step) and the refresh of a connection's tokens (`LazadaRefresher`, run by the worker's channel refresh sweep). Built from Lazada Open Platform's documentation as mirrored on open.alitrip.com
// (articleId 108260 seller authorization and token fields, 121098 apps and token lifetimes, 108068 signature), then checked against the OFFICIAL pages of open.lazada.com, which load in a headless browser
// (read 2026-11-21; the table of what matched is https://github.com/DOS/Ludy/issues/2522#issuecomment-7058540099): the host (auth.lazada.com for both calls), the paths, the parameters, the answer fields
// and the refusal code `IllegalRefreshToken` were confirmed. Not confirmed, for the live check (#2522): that a form body is accepted (the official demo puts the parameters in the address), the token
// lifetimes, and the code a used authorization code gets. That check must pass before a deployment names `lazada` in MARKETPLACE_PROVIDERS.
//
// What the documents say: an access token lives 30 days (a test app 7) and its refresh token 180 (a test app 14 or 30: the two pages disagree); a refresh returns a NEW access token AND a new refresh token,
// resets the access duration and does NOT reset the refresh duration; a refresh token cannot itself be refreshed, so after it expires the seller authorizes again. The worker's refresh sweep
// (channel-refresh.ts) does the rest: one sweep at a time, `kernel.channel.refresh` with `ifVersion` so a rotated refresh token is never lost to a half-done write, a refused refresh marks the connection
// expired (and an expired connection is no longer picked, so there is no loop).
//
// One call, to one host, never repeated: a call that was sent and whose answer was lost may already have spent the refresh token (or the single-use authorization code), so asking again could not help and
// a refused answer would then expire a connection that was fine. A lost answer ends as the seller authorizing again, as for Zalo. The sealed secret is the S1 JSON of the connection plus what the
// authorize step added; only the worker opens it, and nothing here puts it, a token or Lazada's text in an error or a log.
import type { Refresher } from '@crove/channel';
import { readCappedAnswer, type Fetch } from './marketplace-adapter-kit.ts';
import { signLazadaRequest } from './marketplace-lazada.ts';

// The one host of both token calls: the official pages (read 2026-11-21 in a headless browser, #2522) give `https://auth.lazada.com/rest` for GenerateAccessToken AND for RefreshAccessToken (the mirror's
// sample had pointed the refresh at api.lazada.com, which the official page does not say). Both are `GET/POST` there; the official demo of a create puts the parameters in the address, this code sends them
// as a form body so a token or a code is never in a URL.
export const LAZADA_AUTH_HOST = 'auth.lazada.com';
export const LAZADA_TOKEN_HOSTS: readonly string[] = [LAZADA_AUTH_HOST];
const REFRESH_PATH = '/auth/token/refresh';
const CREATE_PATH = '/auth/token/create';

// Renew when the access token has under five days left (article 121098 advises 48 hours, 108260 thirty minutes: both are far inside this, so a worker that was down for days still renews in time).
// channel_refresh_due caps the window at seven days.
export const LAZADA_REFRESH_HORIZON_SECONDS = 5 * 86_400;
// A connection whose access life is not longer than the horizon is due at every sweep: it is renewed at most this often, so a short life (a test app, an odd answer) does not rotate the pair every ten minutes.
const MIN_REFRESH_GAP_MS = 6 * 3_600_000;
// The refresh answer is a few hundred bytes.
const MAX_ANSWER_BYTES = 64_000;
// An access token lasts days to a month; a lifetime outside these bounds is not taken, and the one used instead is a day, so a good pair is never thrown away over a field: the connection is due again
// at once (after the minimum gap) and takes the lifetime of the next answer.
const MIN_LIFETIME_S = 60;
const MAX_LIFETIME_S = 400 * 86_400;
const FALLBACK_LIFETIME_S = 86_400;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const token = (v: unknown): v is string => typeof v === 'string' && v.length >= 1 && v.length <= 400 && v === v.trim() && /^[\x21-\x7e]+$/.test(v);
const lifetime = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d{1,10}$/.test(v) ? Number(v) : Number.NaN;
  return Number.isFinite(n) && n >= MIN_LIFETIME_S && n <= MAX_LIFETIME_S ? n : null;
};
// The code of a refusal as it may be kept in the audit reason: a short word, never Lazada's sentence.
const safeCode = (code: string, otherwise: string): string => (/^[A-Za-z0-9_.-]{1,40}$/.test(code) ? code : otherwise);

// A refusal is decided by the answer's CODE alone, never by its free text (a message that names the refresh token in a bad-request or signature answer must not expire a healthy connection): a code
// that names the refresh token (or, for a create, the authorization code) as illegal, invalid, expired, used or revoked, or the OAuth word `invalid_grant`. Only `IllegalRefreshToken` is on an official page
// (RefreshAccessToken: "The specified refresh token is invalid or expired"); the rest is what the live check confirms; an unknown code is a failure. `AUTH_TYPE_UNSUPPORTED` (an app on the Service Market:
// its token is bound to the subscription and is not refreshed) is a failure here and would be retried at every sweep; that is the Cloud app's case, not the self-hosted one.
const REFRESH_REFUSED = /^(illegal|invalid|expired|revoked)[ _]?refresh[ _]?token$/i;
const CODE_REFUSED = /^(illegal|invalid|expired|used|revoked)[ _]?(authori[sz]ation[ _]?)?code$/i;
const refusedBy = (answer: Record<string, unknown>, code: string, pattern: RegExp): boolean => pattern.test(code) || answer.error === 'invalid_grant';
// What a refusal is reported as: the code when it is the one that names the dead token, else the OAuth word that did (never a code this module made up for a non-2xx answer).
const refusalCode = (code: string, pattern: RegExp): string => (pattern.test(code) ? safeCode(code, 'REFUSED') : 'invalid_grant');

interface Called {
  answer: Record<string, unknown>;
}
interface Troubled {
  failed: string;
}

// One signed POST to a token endpoint, as in Lazada's own SDK: the system parameters in the address, the API's own parameters in the form body, the signature over all of them (no access token: these
// calls are made before one exists or with its pair about to be replaced).
async function postToken(fetchImpl: Fetch, host: string, path: string, appKey: string, appSecret: string, form: Record<string, string>, nowMs: number): Promise<Called | Troubled> {
  const all: Record<string, string> = { app_key: appKey, timestamp: String(nowMs), sign_method: 'sha256', ...form };
  const sign = signLazadaRequest(appSecret, path, all);
  const inUrl = { app_key: appKey, timestamp: String(nowMs), sign_method: 'sha256', sign };
  let response: Response;
  try {
    response = await fetchImpl(`https://${host}/rest${path}?${new URLSearchParams(inUrl).toString()}`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
    });
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
    // A success is a 2xx answer with code 0 (or no code); a refusal or a trouble carries its own code.
    return response.status >= 200 && response.status < 300 ? { answer } : { answer: { ...answer, code: answer.code === undefined || String(answer.code) === '0' ? `HTTP_${response.status}` : answer.code } };
  } catch {
    return { failed: 'BAD_ANSWER' };
  }
}

interface Tokens {
  accessToken: string;
  refreshToken: string;
  accessExpiresAtMs: number;
  // The end of the refresh life as the answer implies it, or null when the answer does not say.
  refreshExpiresAtMs: number | null;
}

// The pair of a good answer: both tokens usable, the access life as given or the fallback day, the refresh life when the answer says it.
function tokensOf(answer: Record<string, unknown>, nowMs: number): Tokens | null {
  if (!token(answer.access_token) || !token(answer.refresh_token)) return null;
  const refreshSeconds = lifetime(answer.refresh_expires_in);
  return {
    accessToken: answer.access_token,
    refreshToken: answer.refresh_token,
    accessExpiresAtMs: nowMs + (lifetime(answer.expires_in) ?? FALLBACK_LIFETIME_S) * 1000,
    refreshExpiresAtMs: refreshSeconds === null ? null : nowMs + refreshSeconds * 1000,
  };
}

export interface LazadaTokenOptions {
  // Bound to LAZADA_TOKEN_HOSTS by the caller (hostBoundFetch); nothing here uses another.
  fetch: Fetch;
  now?: () => Date;
}

// What the authorize step gets: the sealed secret of the connection (the seller's App Key and Secret with the new pair and their dates), the access expiry (what the channel connection's `expiresAt` is, so the
// sweep picks it up), and the end of the refresh life (the date a person must authorize again by).
export interface LazadaGrant {
  secret: string;
  accessExpiresAt: Date;
  refreshExpiresAt: Date | null;
  sellerId: string | null;
  country: string | null;
}

// Trades the single-use authorization code the seller's consent returned for the token pair (token create, auth.lazada.com). `refused`: Lazada says the code is bad, used or expired, and the seller must
// authorize again; `failed`: anything else. A code is single use, so a lost answer is never asked again either.
export async function createLazadaToken(options: LazadaTokenOptions, input: { appKey: string; appSecret: string; code: string }): Promise<LazadaGrant | { refused: string } | { failed: string }> {
  const now = (options.now ?? (() => new Date()))().getTime();
  if (!token(input.appKey) || !token(input.appSecret)) return { refused: 'BAD_SECRET' };
  if (!token(input.code)) return { refused: 'BAD_CODE' };
  const called = await postToken(options.fetch, LAZADA_AUTH_HOST, CREATE_PATH, input.appKey, input.appSecret, { code: input.code }, now);
  if ('failed' in called) return called;
  const code = called.answer.code === undefined ? '' : String(called.answer.code);
  if (code !== '0' && code !== '') return refusedBy(called.answer, code, CODE_REFUSED) ? { refused: refusalCode(code, CODE_REFUSED) } : { failed: safeCode(code, 'UNKNOWN') };
  if (code === '' && called.answer.error !== undefined) return called.answer.error === 'invalid_grant' ? { refused: 'invalid_grant' } : { failed: 'BAD_ANSWER' };
  const tokens = tokensOf(called.answer, now);
  if (!tokens) return { failed: 'BAD_ANSWER' };
  // The seller and the market, as short words only: the first user entry's seller id (digits) and a two-letter country. The account's name and e-mail in the answer are personal data and are not kept.
  const info = Array.isArray(called.answer.country_user_info) ? called.answer.country_user_info[0] : undefined;
  const sellerId = isRecord(info) && typeof info.seller_id === 'string' && /^\d{1,20}$/.test(info.seller_id) ? info.seller_id : null;
  const country = typeof called.answer.country === 'string' && /^[a-z]{2}$/.test(called.answer.country) ? called.answer.country : null;
  const accessExpiresAt = new Date(tokens.accessExpiresAtMs);
  const refreshExpiresAt = tokens.refreshExpiresAtMs === null ? null : new Date(tokens.refreshExpiresAtMs);
  const secret = JSON.stringify({
    appKey: input.appKey,
    appSecret: input.appSecret,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    accessExpiresAt: accessExpiresAt.toISOString(),
    ...(refreshExpiresAt ? { refreshExpiresAt: refreshExpiresAt.toISOString() } : {}),
    refreshedAt: new Date(now).toISOString(),
    ...(sellerId ? { sellerId } : {}),
    ...(country ? { country } : {}),
  });
  return { secret, accessExpiresAt, refreshExpiresAt, sellerId, country };
}

export class LazadaRefresher implements Refresher {
  readonly provider = 'marketplace_lazada' as const;
  readonly horizonSeconds = LAZADA_REFRESH_HORIZON_SECONDS;
  private readonly fetchImpl: Fetch;
  private readonly now: () => Date;

  constructor(options: LazadaTokenOptions) {
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
    const oldRefreshExpiry = typeof old.refreshExpiresAt === 'string' ? Date.parse(old.refreshExpiresAt) : Number.NaN;
    // The refresh token's own life is never extended and cannot be renewed: past its end there is nothing to try, so no call is made (and none is made with a token known to be dead).
    if (!Number.isNaN(oldRefreshExpiry) && oldRefreshExpiry <= now) return { refused: 'REFRESH_TOKEN_EXPIRED' };
    // Renewed a moment ago and due again (a short access life): not asked again yet, so the pair is not rotated at every sweep.
    const lastAt = typeof old.refreshedAt === 'string' ? Date.parse(old.refreshedAt) : Number.NaN;
    if (!Number.isNaN(lastAt) && now >= lastAt && now - lastAt < MIN_REFRESH_GAP_MS) return { failed: 'RECENT' };

    const called = await postToken(this.fetchImpl, LAZADA_AUTH_HOST, REFRESH_PATH, old.appKey, old.appSecret, { refresh_token: old.refreshToken }, now);
    if ('failed' in called) return called;
    const code = called.answer.code === undefined ? '' : String(called.answer.code);
    if (code !== '0' && code !== '') return refusedBy(called.answer, code, REFRESH_REFUSED) ? { refused: refusalCode(code, REFRESH_REFUSED) } : { failed: safeCode(code, 'UNKNOWN') };
    if (code === '' && called.answer.error !== undefined) return called.answer.error === 'invalid_grant' ? { refused: 'invalid_grant' } : { failed: 'BAD_ANSWER' };
    const tokens = tokensOf(called.answer, now);
    if (!tokens) return { failed: 'BAD_ANSWER' };

    // The access life restarts; the refresh life does not: the date kept is the earlier of the one we had and the one Lazada's answer implies, so no later date is ever believed.
    const known = [oldRefreshExpiry, tokens.refreshExpiresAtMs ?? Number.NaN].filter((v) => !Number.isNaN(v));
    const next: Record<string, unknown> = { ...old, accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, accessExpiresAt: new Date(tokens.accessExpiresAtMs).toISOString(), refreshedAt: new Date(now).toISOString() };
    if (known.length > 0) next.refreshExpiresAt = new Date(Math.min(...known)).toISOString();
    else delete next.refreshExpiresAt;
    return { secret: JSON.stringify(next), expiresAt: new Date(tokens.accessExpiresAtMs) };
  }
}

// SPDX-License-Identifier: AGPL-3.0-only
// Renewing a Lazada connection's tokens (#2524, S3a = #4240; design https://github.com/DOS/Ludy/issues/4240#issuecomment-7057958649). Built from Lazada Open Platform's documentation as mirrored on
// open.alitrip.com (articleId 108260 seller authorization and token fields, 121098 apps and token lifetimes, 108068 signature) and read 2026-11-21: open.lazada.com itself could not be read, so the
// host, the method and the error words below are pointers for the live check (#2522), not verified ones.
//
// What the documents say: an access token lives 30 days (a test app 7) and its refresh token 180 (a test app 14 or 30: the two pages disagree); a refresh returns a NEW access token AND a new refresh
// token, resets the access duration and does NOT reset the refresh duration; a refresh token cannot itself be refreshed, so after it expires the seller authorizes again. The worker's refresh sweep
// (channel-refresh.ts) does the rest: one sweep at a time, `kernel.channel.refresh` with `ifVersion` so a rotated refresh token is never lost to a half-done write, a refused refresh marks the
// connection expired (and an expired connection is no longer picked, so there is no loop).
//
// One call, to one host, never repeated: a refresh that was sent and whose answer was lost may already have spent the refresh token, so asking again (or another host) could not help and a refused
// answer would then expire a connection that was fine. A lost answer ends as the connection being expired and reconnected by a person, as for Zalo. The sealed secret is the S1 JSON of the
// connection plus what the authorize step added; only the worker opens it, and nothing here puts it, a token or Lazada's text in an error or a log.
import type { Refresher } from '@crove/channel';
import { readCappedAnswer, type Fetch } from './marketplace-adapter-kit.ts';
import { signLazadaRequest } from './marketplace-lazada.ts';

// The host of the refresh sample in article 108260. Token CREATE is at auth.lazada.com (article 121098 says it is the only address of that API); which of the two a refresh needs is a live-check
// item, so exactly one is named here and the caller's fetch is bound to it.
export const LAZADA_TOKEN_HOST = 'api.lazada.com';
export const LAZADA_TOKEN_HOSTS: readonly string[] = [LAZADA_TOKEN_HOST];
const REFRESH_PATH = '/auth/token/refresh';

// Renew when the access token has under five days left (article 121098 advises 48 hours, 108260 thirty minutes: both are far inside this, so a worker that was down for days still renews in time).
// channel_refresh_due caps the window at seven days.
export const LAZADA_REFRESH_HORIZON_SECONDS = 5 * 86_400;
// The refresh answer is a few hundred bytes.
const MAX_ANSWER_BYTES = 64_000;
// An access token lasts days to a month; a lifetime outside these bounds is not Lazada's answer.
const MIN_LIFETIME_S = 60;
const MAX_LIFETIME_S = 400 * 86_400;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const token = (v: unknown): v is string => typeof v === 'string' && v.length >= 1 && v.length <= 400 && v === v.trim() && /^[\x21-\x7e]+$/.test(v);
const lifetime = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d{1,10}$/.test(v) ? Number(v) : Number.NaN;
  return Number.isFinite(n) && n >= MIN_LIFETIME_S && n <= MAX_LIFETIME_S ? n : null;
};

export interface LazadaRefresherOptions {
  // Bound to LAZADA_TOKEN_HOSTS by the caller (hostBoundFetch); this refresher uses no other.
  fetch: Fetch;
  now?: () => Date;
}

// A refresh Lazada turned down for the token itself: an answer whose code or message names the refresh token as invalid, illegal, expired or revoked. Anything else (a throttle, an outage, a wrong
// signature, an answer this code does not know) is a failure, never a refusal: the token may still be good and a refusal expires the connection. The official error table could not be read.
const REFUSED_WORDS = /illegal|invalid|expired|revoked|not[ _]?found|incorrect/i;
const NAMES_REFRESH_TOKEN = /refresh[ _]?token/i;
function refusedToken(code: string, message: string): boolean {
  return NAMES_REFRESH_TOKEN.test(`${code} ${message}`) && REFUSED_WORDS.test(`${code} ${message}`);
}
// The code of a refusal as it may be kept in the audit reason: a short word, never Lazada's sentence.
const safeCode = (code: string): string => (/^[A-Za-z0-9_.-]{1,40}$/.test(code) ? code : 'REFUSED');

export class LazadaRefresher implements Refresher {
  readonly provider = 'marketplace_lazada' as const;
  readonly horizonSeconds = LAZADA_REFRESH_HORIZON_SECONDS;
  private readonly fetchImpl: Fetch;
  private readonly now: () => Date;

  constructor(options: LazadaRefresherOptions) {
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

    const params: Record<string, string> = { app_key: old.appKey, timestamp: String(now), sign_method: 'sha256', refresh_token: old.refreshToken };
    params.sign = signLazadaRequest(old.appSecret, REFRESH_PATH, params);
    // As in Lazada's own SDK: the system parameters in the address, the API's own (the refresh token) in the form body; the signature covers both.
    const { refresh_token: refreshToken, ...inUrl } = params;
    let response: Response;
    try {
      response = await this.fetchImpl(`https://${LAZADA_TOKEN_HOST}/rest${REFRESH_PATH}?${new URLSearchParams(inUrl).toString()}`, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ refresh_token: refreshToken }).toString(),
      });
    } catch {
      return { failed: 'NETWORK' };
    }
    let answer: unknown;
    try {
      if (response.status === 429 || response.status >= 500) {
        await response.body?.cancel().catch(() => undefined);
        return { failed: String(response.status) };
      }
      answer = JSON.parse(await readCappedAnswer(response, () => new Error('too large'), MAX_ANSWER_BYTES));
    } catch {
      return { failed: 'BAD_ANSWER' };
    }
    if (!isRecord(answer)) return { failed: 'BAD_ANSWER' };
    const code = answer.code === undefined ? '' : String(answer.code);
    if (code !== '0' && code !== '') {
      const message = typeof answer.message === 'string' ? answer.message : '';
      return refusedToken(code, message) ? { refused: safeCode(code) } : { failed: safeCode(code) };
    }
    const accessSeconds = lifetime(answer.expires_in);
    if (!token(answer.access_token) || !token(answer.refresh_token) || accessSeconds === null) return { failed: 'BAD_ANSWER' };

    // The access life restarts; the refresh life does not: the date kept is the earlier of the one we had and the one Lazada's answer implies, so no later date is ever believed.
    const accessExpiresAt = new Date(now + accessSeconds * 1000);
    const refreshSeconds = lifetime(answer.refresh_expires_in);
    const fromAnswer = refreshSeconds === null ? Number.NaN : now + refreshSeconds * 1000;
    const known = [oldRefreshExpiry, fromAnswer].filter((v) => !Number.isNaN(v));
    const next: Record<string, unknown> = { ...old, accessToken: answer.access_token, refreshToken: answer.refresh_token, accessExpiresAt: accessExpiresAt.toISOString() };
    if (known.length > 0) next.refreshExpiresAt = new Date(Math.min(...known)).toISOString();
    return { secret: JSON.stringify(next), expiresAt: accessExpiresAt };
  }
}

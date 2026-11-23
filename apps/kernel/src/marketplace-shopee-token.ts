// SPDX-License-Identifier: AGPL-3.0-only
// The Shopee token API (#2524, S1 = #4274; design https://github.com/DOS/Ludy/issues/2524#issuecomment-7061583765): the authorization code traded for a token pair (`createShopeeToken`, called once by the
// authorize step) and the refresh of a connection's tokens (`ShopeeRefresher`, run by the worker's channel refresh sweep). DORMANT: nothing offers `shopee` until the live check (#2522). Built from the
// OFFICIAL guide page "Authorization and Authentication" (open.shopee.com/developer-guide/16, read 2026-11-21):
//   - both calls are a signed POST on `https://partner.shopeemobile.com/api/v2/auth/token/get` and `.../auth/access_token/get`: the partner id, the timestamp and the signature in the query (signed over
//     partner id + path + timestamp), the code or the refresh token with the shop id and the partner id in the JSON body; the answer is the object itself (no `response` wrapper): `error` (empty on success),
//     `message`, `request_id`, `access_token`, `refresh_token` and `expire_in` (seconds);
//   - an authorization code lives 10 minutes and works once. The access token lives 4 hours. THE REFRESH TOKEN LIVES 30 DAYS, WORKS ONCE AND IS REPLACED BY EVERY REFRESH ("the new refresh_token must be used
//     for the next refresh"); the access token it replaces stays valid 5 more minutes. After a refresh the shop has its own pair.
// Not confirmed, for the live check: the error words a dead or spent refresh token gets (the page lists none, so a refresh is refused only locally, by the dates, and every other trouble is a failure: a
// network trouble is tried again at the next sweep, a verdict Shopee gives that this module cannot read as a refusal is not asked again for 30 minutes, kept in memory), the authorization end (the shop
// info answer carries it, `expire_time`, read by the authorize step and handed to the refresher in the secret) and the real lifetimes.
//
// THE KEY AND THE TOKEN IN THE ADDRESS. The signed address carries the partner id, the timestamp and the signature, never the key; but a shop call's address carries the access token (the caller, marketplace-shopee.ts).
// Here the address carries no token: still, it is built in ONE function (`postToken`), handed only to the host-bound fetch and never kept, logged or put in an error: every failure of the call ends as a
// short closed word ("NETWORK", "BAD_ANSWER", an HTTP status or a code of this module), never the error object, the URL or Shopee's text. The sealed secret is the JSON of the connection; only the worker opens it.
//
// One call, to one host, never repeated: a call that was sent and whose answer was lost may already have spent the refresh token or the single-use code, so asking again could not help and a refusal would
// then expire a connection that was fine. A lost answer ends as the seller authorizing again.
import { createHash } from 'node:crypto';
import type { Refresher } from '@ludy/channel';
import { readCappedAnswer, type Fetch } from './marketplace-adapter-kit.ts';
import { signShopeeRequest } from './marketplace-shopee-sign.ts';

export const SHOPEE_API_HOST = 'partner.shopeemobile.com';
export const SHOPEE_TOKEN_HOSTS: readonly string[] = [SHOPEE_API_HOST];
const GET_PATH = '/api/v2/auth/token/get';
const REFRESH_PATH = '/api/v2/auth/access_token/get';

// The access token lasts 4 hours: it is renewed when under 30 minutes are left (the sweep runs every ten minutes), and an expired one at once.
export const SHOPEE_REFRESH_HORIZON_SECONDS = 1800;
// A refresh token lives 30 days from the refresh that issued it.
export const SHOPEE_REFRESH_TOKEN_LIFETIME_MS = 30 * 86_400_000;
// A verdict Shopee gave that this module cannot read as a refusal is not asked again for this long.
const VERDICT_GAP_MS = 30 * 60_000;
const MAX_ANSWER_BYTES = 64_000;
// An access life outside these bounds is not taken from the answer: it falls back to one hour (the connection is due again soon and takes the answer after), so a good pair is never thrown away over a field.
const MAX_LIFETIME_S = 2 * 86_400;
const FALLBACK_LIFETIME_S = 3600;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const token = (v: unknown): v is string => typeof v === 'string' && v.length >= 1 && v.length <= 400 && v === v.trim() && /^[\x21-\x7e]+$/.test(v);
const digits = (v: unknown, max: number): v is string => typeof v === 'string' && /^[1-9]\d*$/.test(v) && v.length <= max;
// A word of Shopee's `error` field as it may be reported: lower-case words, dots and underscores, or the `HTTP_<status>` this module makes for an answer that has none; every other text is `otherwise`, so nothing
// the host sends as an "error" is passed on.
const safeWord = (word: string, otherwise: string): string => (/^([a-z][a-z0-9_.]{0,59}|HTTP_\d{3})$/.test(word) ? word : otherwise);

interface Called {
  answer: Record<string, unknown>;
  // Shopee's `error` word; empty on success.
  error: string;
}
interface Troubled {
  failed: string;
}

// The one place a token URL exists. A POST of a JSON body, no redirect (the bound fetch), the answer capped.
async function postToken(fetchImpl: Fetch, partnerKey: string, partnerId: string, path: string, nowMs: number, body: Record<string, unknown>): Promise<Called | Troubled> {
  const timestamp = Math.floor(nowMs / 1000);
  const sign = signShopeeRequest(partnerKey, partnerId, path, timestamp);
  let response: Response;
  try {
    response = await fetchImpl(`https://${SHOPEE_API_HOST}${path}?${new URLSearchParams({ partner_id: partnerId, timestamp: String(timestamp), sign }).toString()}`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(body),
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
    const error = typeof answer.error === 'string' ? answer.error : answer.error === undefined || answer.error === null ? '' : 'BAD_ANSWER';
    if (error === 'BAD_ANSWER') return { failed: 'BAD_ANSWER' };
    // A success is a 2xx answer with an empty `error`; any other answer carries its own word (or HTTP_<status> when it has none).
    if (response.ok && error === '') return { answer, error };
    return { answer, error: error === '' ? `HTTP_${response.status}` : error };
  } catch {
    return { failed: 'BAD_ANSWER' };
  }
}

interface Tokens {
  accessToken: string;
  refreshToken: string;
  accessExpiresAtMs: number;
}

// The pair of a good answer: both tokens usable, the access end from `expire_in` (seconds from now) or one hour from now when the field is not a plausible life. The refresh token's own end is 30 days from now.
function tokensOf(answer: Record<string, unknown>, nowMs: number): Tokens | null {
  if (!token(answer.access_token) || !token(answer.refresh_token)) return null;
  const life = typeof answer.expire_in === 'number' && Number.isInteger(answer.expire_in) && answer.expire_in > 0 && answer.expire_in <= MAX_LIFETIME_S ? answer.expire_in : FALLBACK_LIFETIME_S;
  return { accessToken: answer.access_token, refreshToken: answer.refresh_token, accessExpiresAtMs: nowMs + life * 1000 };
}

export interface ShopeeTokenOptions {
  // Bound to SHOPEE_TOKEN_HOSTS by the caller (hostBoundFetch); nothing here uses another.
  fetch: Fetch;
  now?: () => Date;
}

// What the authorize step gets: the sealed secret of the connection (the partner id and key, the shop, the new pair and their dates), the access end (the channel connection's `expiresAt`, so the sweep picks it up)
// and the end of the refresh token (the date after which the seller must authorize again unless a refresh came first).
export interface ShopeeGrant {
  secret: string;
  accessExpiresAt: Date;
  refreshExpiresAt: Date;
}

// Trades the single-use authorization code the seller's consent returned (with the shop id of the redirect) for the token pair. `refused`: the input is not one a call can be made with. `failed`: anything else,
// a word of Shopee's included (a bad, used or expired code is one: its word is not documented, so none is invented). A code is single use, so a lost answer is never asked again either.
export async function createShopeeToken(
  options: ShopeeTokenOptions,
  input: { partnerId: string; partnerKey: string; shopId: string; code: string; authorizationEndsAt?: Date | null },
): Promise<ShopeeGrant | { refused: string } | { failed: string }> {
  const nowMs = (options.now ?? (() => new Date()))().getTime();
  if (!digits(input.partnerId, 12) || !token(input.partnerKey)) return { refused: 'BAD_SECRET' };
  if (!digits(input.shopId, 15)) return { refused: 'BAD_SHOP' };
  if (!token(input.code)) return { refused: 'BAD_CODE' };
  const called = await postToken(options.fetch, input.partnerKey, input.partnerId, GET_PATH, nowMs, { code: input.code, shop_id: Number(input.shopId), partner_id: Number(input.partnerId) });
  if ('failed' in called) return called;
  if (called.error !== '') return { failed: safeWord(called.error, 'UNKNOWN') };
  const tokens = tokensOf(called.answer, nowMs);
  if (!tokens) return { failed: 'BAD_ANSWER' };
  const accessExpiresAt = new Date(tokens.accessExpiresAtMs);
  const refreshExpiresAt = new Date(nowMs + SHOPEE_REFRESH_TOKEN_LIFETIME_MS);
  const secret = JSON.stringify({
    partnerId: input.partnerId,
    partnerKey: input.partnerKey,
    shopId: input.shopId,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    accessExpiresAt: accessExpiresAt.toISOString(),
    refreshExpiresAt: refreshExpiresAt.toISOString(),
    refreshedAt: new Date(nowMs).toISOString(),
    ...(input.authorizationEndsAt ? { authorizationEndsAt: input.authorizationEndsAt.toISOString() } : {}),
  });
  return { secret, accessExpiresAt, refreshExpiresAt };
}

export class ShopeeRefresher implements Refresher {
  readonly provider = 'marketplace_shopee' as const;
  readonly horizonSeconds = SHOPEE_REFRESH_HORIZON_SECONDS;
  private readonly fetchImpl: Fetch;
  private readonly now: () => Date;
  // When Shopee last gave a VERDICT (an answer with an error word this module cannot read as a refusal, or a success it cannot read) for a connection's refresh token, by a hash of the partner id and the
  // token. Without this a verdict that never changes would be asked again at every ten-minute sweep, and each ask would be one more call with a token that may already be spent. It lives in memory (a restart
  // asks once more) and never holds a token: only a hash. A network trouble or a 429 or 5xx is not a verdict and is tried again at the next sweep.
  private readonly verdicts = new Map<string, number>();

  constructor(options: ShopeeTokenOptions) {
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
    if (!digits(old.partnerId, 12) || !token(old.partnerKey) || !digits(old.shopId, 15)) return { refused: 'BAD_SECRET' };
    // The authorize step has not added the tokens, or the connection holds no refresh token: nothing to renew with, and it must be authorized again.
    if (!token(old.refreshToken)) return { refused: 'NO_REFRESH_TOKEN' };
    const nowMs = this.now().getTime();
    // The seller's authorization has an end (at most 365 days, the seller's choice): past it nothing can be renewed, so no call is made. The refresh token's own end (30 days from the refresh that issued it)
    // is the same: a token known to be dead is never sent.
    const authorizationEnd = typeof old.authorizationEndsAt === 'string' ? Date.parse(old.authorizationEndsAt) : Number.NaN;
    if (!Number.isNaN(authorizationEnd) && authorizationEnd <= nowMs) return { refused: 'AUTHORIZATION_ENDED' };
    const tokenEnd = typeof old.refreshExpiresAt === 'string' ? Date.parse(old.refreshExpiresAt) : Number.NaN;
    if (!Number.isNaN(tokenEnd) && tokenEnd <= nowMs) return { refused: 'REFRESH_TOKEN_EXPIRED' };

    // A verdict Shopee gave for this very refresh token a moment ago is not asked again yet (see `verdicts`); old entries are dropped here.
    for (const [seen, at] of this.verdicts) if (nowMs < at || nowMs - at >= VERDICT_GAP_MS) this.verdicts.delete(seen);
    const key = createHash('sha256').update(`${old.partnerId}\n${old.refreshToken}`).digest('hex');
    if (this.verdicts.has(key)) return { failed: 'RECENT' };

    const called = await postToken(this.fetchImpl, old.partnerKey, old.partnerId, REFRESH_PATH, nowMs, { refresh_token: old.refreshToken, shop_id: Number(old.shopId), partner_id: Number(old.partnerId) });
    if ('failed' in called) return called;
    if (called.error !== '') {
      this.verdicts.set(key, nowMs);
      return { failed: safeWord(called.error, 'UNKNOWN') };
    }
    const tokens = tokensOf(called.answer, nowMs);
    if (!tokens) {
      this.verdicts.set(key, nowMs);
      return { failed: 'BAD_ANSWER' };
    }
    // The pair is replaced whole (the refresh token rotates); the authorization end, which a refresh never moves, stays as it was.
    const next: Record<string, unknown> = {
      ...old,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      accessExpiresAt: new Date(tokens.accessExpiresAtMs).toISOString(),
      refreshExpiresAt: new Date(nowMs + SHOPEE_REFRESH_TOKEN_LIFETIME_MS).toISOString(),
      refreshedAt: new Date(nowMs).toISOString(),
    };
    return { secret: JSON.stringify(next), expiresAt: new Date(tokens.accessExpiresAtMs) };
  }
}

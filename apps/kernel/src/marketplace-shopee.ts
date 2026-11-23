// SPDX-License-Identifier: AGPL-3.0-only
// The Shopee Open API caller, the shop info and the connection test (#2524, S1 = #4274; design https://github.com/DOS/Ludy/issues/2524#issuecomment-7061583765), DORMANT: nothing offers `shopee` to a
// deployment until the live check (#2522) has confirmed what this assumes. Built from the OFFICIAL pages read on 2026-11-21 (open.shopee.com/developer-guide/16, the v2.order, v2.shop and v2.payment
// reference pages; the table of pages is in the design note):
//   - host: `https://partner.shopeemobile.com` for a Vietnam shop (the `.cn` host is for China only), https only, GET and POST only;
//   - signing: marketplace-shopee-sign.ts; `partner_id`, `timestamp`, `sign`, `access_token` and `shop_id` are QUERY parameters of every shop call, the body is not signed;
//   - the answer is `{ request_id, error, message, response }`: `error` is empty on success and a word on failure. The words the pages name: `error_auth` and `common.error_auth` (a bad token or signature),
//     `error_permission`, `error_param`, `error_server`, `error_network`, `error_data`, `error_shop`; nothing the pages say tells a throttle apart, so only HTTP 429 and a closed list of words read as one.
//
// READ ONLY: GET (and a POST that reads, later). Every failure is one of the port's kinds (with a short `reason` for the test mapping), never Shopee's text, the URL or a token. One turn-taking per partner and
// shop, so the orders poll and the later reads (returns, escrow) share the pace; the platform publishes no rate figure, so the start is conservative and `rate_limited` backs the worker off.
//
// THE TOKEN IN THE ADDRESS. A shop call carries the access token and the signature in the query, so the URL is built here, handed only to the host-bound fetch and never kept, logged or put in an error.
import { MarketplaceProviderError, type MarketplaceTestResult } from '@ludy/mod-finance';
import { cleanLabel, marketplaceIdentifier, pickAllowed, readCappedAnswer, type Fetch } from './marketplace-adapter-kit.ts';
import { signShopeeRequest } from './marketplace-shopee-sign.ts';
import { SHOPEE_API_HOST } from './marketplace-shopee-token.ts';

export { SHOPEE_API_HOST };
export const SHOPEE_HOSTS: readonly string[] = [SHOPEE_API_HOST];
const SHOP_INFO_PATH = '/api/v2/shop/get_shop_info';
// A start the platform's missing figure allows: one call a second per partner and shop, the port's 60 a minute.
const DEFAULT_SPACING_MS = 1000;

// The sealed secret of a connection: the partner (the seller's own app or the owner's) and the pair the authorize step added, for one shop.
export interface ShopeeCredential {
  partnerId: string;
  partnerKey: string;
  shopId: string;
  accessToken: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const tokenText = (v: unknown): v is string => typeof v === 'string' && v.length >= 1 && v.length <= 400 && v === v.trim() && /^[\x21-\x7e]+$/.test(v);
const digitsText = (v: unknown, max: number): v is string => typeof v === 'string' && /^[1-9]\d*$/.test(v) && v.length <= max;

// A malformed secret is refused as `credentials` without echoing any of it.
export function parseShopeeSecret(secret: string): ShopeeCredential {
  let value: unknown;
  try {
    value = JSON.parse(secret);
  } catch {
    throw new MarketplaceProviderError('credentials');
  }
  const picked = pickAllowed(value, ['partnerId', 'partnerKey', 'shopId', 'accessToken'] as const);
  if (!picked || !digitsText(picked.partnerId, 12) || !tokenText(picked.partnerKey) || !digitsText(picked.shopId, 15) || !tokenText(picked.accessToken)) throw new MarketplaceProviderError('credentials');
  return { partnerId: picked.partnerId, partnerKey: picked.partnerKey, shopId: picked.shopId, accessToken: picked.accessToken };
}

// Why a `credentials` failure happened, so the connection test can say it in words; `unknown` is every other refusal of the credentials.
export type ShopeeCredentialReason = 'signature' | 'scope' | 'shop' | 'unknown';

export class ShopeeApiError extends MarketplaceProviderError {
  readonly reason: ShopeeCredentialReason | null;
  constructor(kind: MarketplaceProviderError['kind'], reason: ShopeeCredentialReason | null = null) {
    super(kind);
    this.reason = reason;
  }
}

// The words that mean the credentials (or the app's rights) are not accepted. `error_permission` is the app type not being allowed that API (the pages list the app types per API).
const CREDENTIAL_WORDS: Readonly<Record<string, ShopeeCredentialReason>> = {
  error_auth: 'signature',
  'common.error_auth': 'signature',
  error_permission: 'scope',
  error_shop: 'shop',
};
// The words of a throttle, as far as a closed list can read one; the platform's page names none, so a live check confirms them.
const THROTTLE_WORD = /(^|[._])(rate|limit|frequen|throttl|too_many)/;
// The words of a request this adapter made wrong or an answer it cannot read (a window past 15 days, a bad parameter, an order not found): not an outage and not a refusal.
const UNREADABLE_WORD = /^(error_param|error_data|error_not_found|order\.[a-z0-9_]+)$/;

function classify(status: number, error: string): ShopeeApiError {
  if (status === 429) return new ShopeeApiError('rate_limited');
  if (UNREADABLE_WORD.test(error)) return new ShopeeApiError('not_recognized');
  if (THROTTLE_WORD.test(error)) return new ShopeeApiError('rate_limited');
  if (Object.hasOwn(CREDENTIAL_WORDS, error)) return new ShopeeApiError('credentials', CREDENTIAL_WORDS[error] ?? 'unknown');
  if (status === 401 || status === 403) return new ShopeeApiError('credentials', 'unknown');
  return new ShopeeApiError('unreachable');
}

export interface ShopeeOptions {
  // Bound to SHOPEE_HOSTS by the caller (hostBoundFetch); nothing here uses another host.
  fetch: Fetch;
  now?: () => Date;
  // Pause between two calls of one partner and shop.
  spacingMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface ShopeeRequest {
  method: 'GET' | 'POST';
  path: string;
  // The API's own query parameters; `partner_id`, `timestamp`, `access_token`, `shop_id` and `sign` are added here.
  query: Readonly<Record<string, string>>;
  // The exact JSON text sent for a POST (it is not signed).
  body?: string;
  // Turns the answer text into a value; the default is a plain JSON parse. The orders reader passes one that keeps an amount as the exact text Shopee wrote.
  parse?: (text: string) => unknown;
  // The shop info page lists its fields at the top level of the answer, beside `request_id`; every other call nests them under `response`. A flat call returns the whole answer object.
  flat?: boolean;
}

export type ShopeeCaller = (credential: ShopeeCredential, request: ShopeeRequest) => Promise<unknown>;

const RESERVED = ['partner_id', 'timestamp', 'access_token', 'shop_id', 'sign'] as const;

// The one signed call of the Shopee adapters, with the turn-taking per partner and shop: it returns the `response` of an answer whose `error` is empty.
export function shopeeCaller(options: ShopeeOptions): ShopeeCaller {
  const now = options.now ?? (() => new Date());
  const spacingMs = options.spacingMs ?? DEFAULT_SPACING_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  // The interval is measured from when the last call ACTUALLY started, and one partner-shop pair's calls never hold up another's.
  const lastStart = new Map<string, number>();
  const queue = new Map<string, Promise<void>>();
  async function takeTurn(key: string): Promise<void> {
    const before = queue.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    queue.set(
      key,
      before.then(() => mine),
    );
    await before;
    try {
      const wait = (lastStart.get(key) ?? Number.NEGATIVE_INFINITY) + spacingMs - now().getTime();
      if (wait > 0) await sleep(wait);
      lastStart.set(key, now().getTime());
    } finally {
      release();
    }
  }

  return async (credential, request) => {
    // The five common parameters are the caller's to never pass: they are set here and a duplicate would be signed wrongly or end up in the address twice.
    if (RESERVED.some((name) => Object.hasOwn(request.query, name))) throw new RangeError('reserved query parameter');
    await takeTurn(`${credential.partnerId}:${credential.shopId}`);
    const timestamp = Math.floor(now().getTime() / 1000);
    const sign = signShopeeRequest(credential.partnerKey, credential.partnerId, request.path, timestamp, { accessToken: credential.accessToken, shopId: credential.shopId });
    const query = new URLSearchParams({ ...request.query, partner_id: credential.partnerId, timestamp: String(timestamp), access_token: credential.accessToken, shop_id: credential.shopId, sign });
    let response: Response;
    try {
      response = await options.fetch(`https://${SHOPEE_API_HOST}${request.path}?${query.toString()}`, {
        method: request.method,
        headers: { accept: 'application/json', ...(request.method === 'POST' ? { 'content-type': 'application/json' } : {}) },
        ...(request.method === 'POST' ? { body: request.body ?? '' } : {}),
      });
    } catch {
      throw new ShopeeApiError('unreachable');
    }
    // The answer is read even on a refusal, for its error word only.
    let answer: unknown;
    try {
      answer = (request.parse ?? JSON.parse)(await readCappedAnswer(response, () => new ShopeeApiError('unreachable')));
    } catch {
      answer = undefined;
    }
    // An empty or absent `error` is a success; a word is a failure; anything else (no JSON object, a non-text `error`) is an answer that is not Shopee's.
    const rawError = isRecord(answer) ? answer.error : undefined;
    const error = typeof rawError === 'string' ? rawError : isRecord(answer) && (rawError === undefined || rawError === null) ? '' : 'unreadable';
    if (!response.ok || error !== '') {
      // Only a closed word is passed to the classifier; whatever else Shopee sent is dropped here.
      throw classify(response.status, /^[a-z][a-z0-9_.]{0,59}$/.test(error) ? error : '');
    }
    // An answer that is not an object with a `response` is not Shopee's: a success always carries one (a flat call's answer is the object itself).
    if (!isRecord(answer)) throw new ShopeeApiError('not_recognized');
    if (request.flat === true) return answer;
    if (!isRecord(answer.response)) throw new ShopeeApiError('not_recognized');
    return answer.response;
  };
}

// The fields whose number is kept as the exact text Shopee wrote (an amount, and ids that can pass 2^53); every other number stays a number.
const EXACT_KEYS: ReadonlySet<string> = new Set(['model_original_price', 'model_discounted_price', 'item_id', 'model_id']);

// An answer as JSON in which an amount and an id are kept as the EXACT text Shopee wrote (a JSON number is a float in JS, and a float would round a long amount or turn a long id into another one). The amount
// then has to be a plain decimal string to be taken (marketplaceMoney): an exponent or more than four decimals refuses the page. Every other number stays a number.
export function parseShopeeAnswer(text: string): unknown {
  const reviver = (key: string, value: unknown, context?: { source?: string }): unknown =>
    EXACT_KEYS.has(key) && typeof value === 'number' && typeof context?.source === 'string' ? context.source : value;
  return JSON.parse(text, reviver as unknown as Parameters<typeof JSON.parse>[1]);
}

// A JSON number kept as the exact text Shopee wrote, in the answers whose every number may be an amount (the escrow). It is its own type so a STRING that happens to hold digits (a tax registration code) is never
// read as money.
export class ShopeeNumber {
  readonly text: string;
  constructor(text: string) {
    this.text = text;
  }
}

// An answer as JSON in which EVERY number is a ShopeeNumber (its exact text): nothing passes through a JS float. The escrow reader takes the numbers it needs from it (`numberText`) and refuses any it does not understand.
export function parseShopeeSourceAnswer(text: string): unknown {
  const reviver = (_key: string, value: unknown, context?: { source?: string }): unknown => (typeof value === 'number' ? (typeof context?.source === 'string' ? new ShopeeNumber(context.source) : value) : value);
  return JSON.parse(text, reviver as unknown as Parameters<typeof JSON.parse>[1]);
}

export interface ShopeeShopInfo {
  name: string;
  // Two letters, upper case: the shop's market.
  region: string;
  status: 'NORMAL' | 'BANNED' | 'FROZEN';
  // When the seller's authorization of this app ends (`expire_time`), or null when the answer has none. The authorize step puts it in the sealed secret.
  authorizationEndsAt: Date | null;
}

const SHOP_INFO_FIELDS = ['shop_name', 'region', 'status', 'expire_time'] as const;

// The shop the access token belongs to (`GET /api/v2/shop/get_shop_info`): one call that proves the partner key, the shop and the token sign and are accepted, and gives the shop's market, its status and the
// end of the seller's authorization (so the connection can say "authorize again before DD/MM").
export async function shopeeShopInfo(call: ShopeeCaller, credential: ShopeeCredential, nowMs: number = Date.now()): Promise<ShopeeShopInfo> {
  const data = await call(credential, { method: 'GET', path: SHOP_INFO_PATH, query: {}, flat: true });
  const s = pickAllowed(data, SHOP_INFO_FIELDS);
  const region = typeof s?.region === 'string' && /^[A-Z]{2}$/.test(s.region) ? s.region : null;
  const status = s?.status === 'NORMAL' || s?.status === 'BANNED' || s?.status === 'FROZEN' ? s.status : null;
  if (!s || region === null || status === null || marketplaceIdentifier(s.shop_name, 200) === null) throw new ShopeeApiError('not_recognized');
  // An expiry that is not a plausible Unix time (whole seconds, within two years of now) is left out, never guessed.
  const expiry = typeof s.expire_time === 'number' && Number.isSafeInteger(s.expire_time) ? s.expire_time * 1000 : null;
  const authorizationEndsAt = expiry !== null && expiry > nowMs - 86_400_000 && expiry <= nowMs + 800 * 86_400_000 ? new Date(expiry) : null;
  return { name: cleanLabel(String(s.shop_name), 100), region, status, authorizationEndsAt };
}

// What the connect dialog shows after "test": one call, the shop info. It proves the partner key, the shop and the token sign and are accepted, and that the shop is a Vietnam one in good standing.
export async function testShopeeConnection(call: ShopeeCaller, secret: string): Promise<MarketplaceTestResult> {
  try {
    const info = await shopeeShopInfo(call, parseShopeeSecret(secret));
    // A shop of another market or one the platform has banned or frozen is not a working connection for a Vietnam seller: nothing could be read from it that the ledger should take.
    return info.region === 'VN' && info.status === 'NORMAL' ? 'works' : 'wrong_credentials';
  } catch (error) {
    if (error instanceof ShopeeApiError && error.kind === 'credentials') {
      if (error.reason === 'scope') return 'api_not_enabled';
      return 'wrong_credentials';
    }
    // A secret that does not parse is also `credentials`, without a reason.
    return error instanceof MarketplaceProviderError && error.kind === 'credentials' ? 'wrong_credentials' : 'unreachable';
  }
}

// SPDX-License-Identifier: AGPL-3.0-only
// The TikTok Shop Open API caller, the shop list and the connection test (#2524, T1 = #4256; design https://github.com/DOS/Ludy/issues/2524#issuecomment-7059664269), DORMANT: nothing offers
// `tiktok_shop` to a deployment until the live check (#2522) has confirmed what this assumes. Built from the OFFICIAL Partner Center pages read on 2026-11-21 (the table of pages is in the design note):
//   - host: `https://open-api.tiktokglobalshop.com`, HTTPS only (methods-and-endpoints);
//   - common parameters: `app_key`, `sign`, `timestamp` (10-digit seconds) in the query, the token in the `x-tts-access-token` header, `content-type: application/json`, `shop_cipher` only where an endpoint
//     asks for it (an unneeded one is an error: 36009004 "Unexpected identifier");
//   - signing: marketplace-tiktok-sign.ts;
//   - errors: the codes of "Common errors" (105002 expired token, 106001 bad signature, 105005 missing scope, 101000 bad token header, 36009033 IP not allowed, 36009043 and 36009044 inactive shop or seller,
//     36009002 and HTTP 429 rate limit, 36009004 for many validation failures of which only the credential ones are kept apart, by their documented message words).
//
// READ ONLY: GET and a signed POST body for the search calls of the next slices. Every failure is one of the port's kinds (with a short `reason` for the test mapping), never TikTok's text, the URL or a
// token. One signed turn-taking per app key and shop, so the orders poll and the finance reader of the next slices share the pace; the platform's capacity is dynamic per app and shop (rate-limits page).
import { MarketplaceProviderError, type MarketplaceTestResult } from '@crove/mod-finance';
import { cleanLabel, marketplaceIdentifier, parseMarketplaceJson, pickAllowed, readCappedAnswer, type Fetch } from './marketplace-adapter-kit.ts';
import { signTiktokRequest } from './marketplace-tiktok-sign.ts';

export const TIKTOK_API_HOST = 'open-api.tiktokglobalshop.com';
export const TIKTOK_HOSTS: readonly string[] = [TIKTOK_API_HOST];
const SHOPS_PATH = '/authorization/202309/shops';
const MAX_SHOPS = 100;
// The conservative start of the page "Rate limits" for a standard read (3 to 10 a second per app and shop): one call every 350 ms.
const DEFAULT_SPACING_MS = 350;
const DEFAULT_ID_KEYS = ['id'] as const;

// The sealed secret of a connection: the seller's (or the owner's partner) app and the pair the authorize step added. The shop's cipher and id are added when the shop is chosen.
export interface TiktokCredential {
  appKey: string;
  appSecret: string;
  accessToken: string;
  shopCipher: string | null;
  shopId: string | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const tokenText = (v: unknown): v is string => typeof v === 'string' && v.length >= 1 && v.length <= 400 && v === v.trim() && /^[\x21-\x7e]+$/.test(v);

// A malformed secret is refused as `credentials` without echoing any of it.
export function parseTiktokSecret(secret: string): TiktokCredential {
  let value: unknown;
  try {
    value = JSON.parse(secret);
  } catch {
    throw new MarketplaceProviderError('credentials');
  }
  const picked = pickAllowed(value, ['appKey', 'appSecret', 'accessToken', 'shopCipher', 'shopId'] as const);
  if (!picked || !tokenText(picked.appKey) || !tokenText(picked.appSecret) || !tokenText(picked.accessToken)) throw new MarketplaceProviderError('credentials');
  const shopCipher = picked.shopCipher === undefined ? null : tokenText(picked.shopCipher) ? picked.shopCipher : undefined;
  const shopId = picked.shopId === undefined ? null : typeof picked.shopId === 'string' && /^\d{1,30}$/.test(picked.shopId) ? picked.shopId : undefined;
  if (shopCipher === undefined || shopId === undefined) throw new MarketplaceProviderError('credentials');
  return { appKey: picked.appKey, appSecret: picked.appSecret, accessToken: picked.accessToken, shopCipher, shopId };
}

// Why a `credentials` failure happened, so the connection test can say it in words; `unknown` is every other refusal of the credentials.
export type TiktokCredentialReason = 'expired' | 'signature' | 'scope' | 'ip' | 'inactive' | 'unknown';

export class TiktokApiError extends MarketplaceProviderError {
  readonly reason: TiktokCredentialReason | null;
  constructor(kind: MarketplaceProviderError['kind'], reason: TiktokCredentialReason | null = null) {
    super(kind);
    this.reason = reason;
  }
}

// The documented codes that mean the credentials (or the app's rights) are not accepted. The whole of "Common errors", Authorization and Authentication sections.
const CREDENTIAL_CODES: Readonly<Record<string, TiktokCredentialReason>> = {
  '105002': 'expired',
  '106001': 'signature',
  '105005': 'scope',
  '101000': 'unknown',
  '36009033': 'ip',
  '36009043': 'inactive',
  '36009044': 'inactive',
};
// 36009004 is reused for many validation failures; the page lists the credential ones by these words of the message (and the timestamp ones, which are the worker's clock and must not read as a refusal).
// The message is only matched against this closed list and is never stored or repeated.
const CREDENTIAL_MESSAGE_WORDS = ['missing credentials', 'access_token header is invalid', 'x-tts-access-token header is invalid', 'invalid app_key'] as const;

function classify(status: number, code: string, message: string): TiktokApiError {
  if (status === 429 || code === '36009002') return new TiktokApiError('rate_limited');
  if (Object.hasOwn(CREDENTIAL_CODES, code)) return new TiktokApiError('credentials', CREDENTIAL_CODES[code] ?? 'unknown');
  if (code === '36009004') {
    // The page writes names between backticks; whether the API does is not known, so quotes and backticks are dropped before the match.
    const text = message.toLowerCase().replace(/[`'"]/g, '');
    if (CREDENTIAL_MESSAGE_WORDS.some((word) => text.includes(word))) return new TiktokApiError('credentials', 'unknown');
    return new TiktokApiError('unreachable');
  }
  if (status === 401 || status === 403) return new TiktokApiError('credentials', 'unknown');
  return new TiktokApiError('unreachable');
}

export interface TiktokOptions {
  // Bound to TIKTOK_HOSTS by the caller (hostBoundFetch); nothing here uses another host.
  fetch: Fetch;
  now?: () => Date;
  // Pause between two calls of one app key and shop.
  spacingMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface TiktokRequest {
  method: 'GET' | 'POST';
  path: string;
  // The API's own query parameters; `app_key`, `timestamp` and `sign` are added here. `shop_cipher` goes in only for an endpoint that asks for it.
  query: Readonly<Record<string, string>>;
  // The exact JSON text sent (and signed) for a POST.
  body?: string;
}

export type TiktokCaller = (credential: TiktokCredential, request: TiktokRequest, idKeys?: readonly string[]) => Promise<unknown>;

// The one signed call of the TikTok adapters, with the turn-taking per app key and shop: it returns the `data` of an answer whose code is 0.
export function tiktokCaller(options: TiktokOptions): TiktokCaller {
  const now = options.now ?? (() => new Date());
  const spacingMs = options.spacingMs ?? DEFAULT_SPACING_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  // As in the Lazada caller: the interval is measured from when the last call ACTUALLY started, and one app-shop pair's calls never hold up another's.
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

  return async (credential, request, idKeys = DEFAULT_ID_KEYS) => {
    await takeTurn(`${credential.appKey}:${credential.shopCipher ?? ''}`);
    const query: Record<string, string> = { ...request.query, app_key: credential.appKey, timestamp: String(Math.floor(now().getTime() / 1000)) };
    const body = request.method === 'POST' ? (request.body ?? '') : null;
    const sign = signTiktokRequest(credential.appSecret, request.path, query, body);
    let response: Response;
    try {
      response = await options.fetch(`https://${TIKTOK_API_HOST}${request.path}?${new URLSearchParams({ ...query, sign }).toString()}`, {
        method: request.method,
        headers: { accept: 'application/json', 'content-type': 'application/json', 'x-tts-access-token': credential.accessToken },
        ...(body === null ? {} : { body }),
      });
    } catch {
      throw new TiktokApiError('unreachable');
    }
    // The answer is read even on a refusal, for its code only (the documented codes ride on HTTP 401 and 429 as well as on 200).
    let answer: unknown;
    try {
      answer = parseMarketplaceJson(await readCappedAnswer(response, () => new TiktokApiError('unreachable')), idKeys);
    } catch {
      answer = undefined;
    }
    const code = isRecord(answer) && (typeof answer.code === 'number' || typeof answer.code === 'string') ? String(answer.code) : '';
    const message = isRecord(answer) && typeof answer.message === 'string' ? answer.message : '';
    if (!response.ok || code !== '0') {
      if (!response.ok) await response.body?.cancel().catch(() => undefined);
      throw classify(response.status, code, message);
    }
    return isRecord(answer) ? answer.data : undefined;
  };
}

export interface TiktokShop {
  id: string;
  name: string;
  // Two letters, upper case: the shop's market.
  region: string;
  sellerType: 'LOCAL' | 'CROSS_BORDER';
  // The encrypted shop identifier sent as `shop_cipher`; sealed with the connection, never shown.
  cipher: string;
  code: string | null;
}

const SHOP_FIELDS = ['id', 'name', 'region', 'seller_type', 'cipher', 'code'] as const;

// The shops the access token's seller authorized for the app (`GET /authorization/202309/shops`): a custom app of a seller holds one, an ISV app one per authorizing shop. Each shop as only the fields
// kept; a malformed one refuses the page.
export async function tiktokShops(call: TiktokCaller, credential: TiktokCredential): Promise<TiktokShop[]> {
  const data = await call(credential, { method: 'GET', path: SHOPS_PATH, query: {} });
  const list = isRecord(data) ? data.shops : undefined;
  if (list === undefined) return [];
  if (!Array.isArray(list) || list.length > MAX_SHOPS) throw new TiktokApiError('not_recognized');
  const seen = new Set<string>();
  return list.map((entry): TiktokShop => {
    const s = pickAllowed(entry, SHOP_FIELDS);
    const id = marketplaceIdentifier(s?.id, 30);
    const region = typeof s?.region === 'string' && /^[A-Z]{2}$/.test(s.region) ? s.region : null;
    const sellerType = s?.seller_type === 'LOCAL' || s?.seller_type === 'CROSS_BORDER' ? s.seller_type : null;
    const code = s?.code === undefined || s.code === null || s.code === '' ? null : marketplaceIdentifier(s.code, 40);
    if (!s || id === null || !/^\d+$/.test(id) || region === null || sellerType === null || !tokenText(s.cipher) || (code === null && s.code !== undefined && s.code !== null && s.code !== '') || seen.has(id)) {
      throw new TiktokApiError('not_recognized');
    }
    seen.add(id);
    return { id, name: cleanLabel(typeof s.name === 'string' ? s.name : '', 100), region, sellerType, cipher: s.cipher, code };
  });
}

// What the connect dialog shows after "test": one call, the shop list. It proves the key, the secret and the token sign and are accepted, and nothing more.
export async function testTiktokConnection(call: TiktokCaller, secret: string): Promise<MarketplaceTestResult> {
  try {
    await tiktokShops(call, parseTiktokSecret(secret));
    return 'works';
  } catch (error) {
    if (error instanceof TiktokApiError && error.kind === 'credentials') {
      if (error.reason === 'ip') return 'ip_not_allowed';
      if (error.reason === 'scope') return 'api_not_enabled';
      return 'wrong_credentials';
    }
    // A secret that does not parse is also `credentials`, without a reason.
    return error instanceof MarketplaceProviderError && error.kind === 'credentials' ? 'wrong_credentials' : 'unreachable';
  }
}

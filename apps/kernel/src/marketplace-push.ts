// SPDX-License-Identifier: AGPL-3.0-only
// The check of a marketplace's push (webhook) the worker makes (#4327, S3a of the push receiver #4315): the platform signs the push with the seller's OWN app secret, which only the worker can open (ADR-0025), so the
// API (S2) only stores the raw bytes and this module does the checking. Pure: bytes and a secret in, a verdict out; nothing is logged, kept or returned of the body, the header or the secret.
//
// What each platform signs (first-party pages read 2026-11-21: partner.tiktokshop.com webhooks overview, open.lazada.com Lazada Push Mechanism, open.shopee.com push mechanism notifications): the `Authorization`
// header is the lowercase hex of an HMAC-SHA256 with the app secret.
// - TikTok Shop: over `app_key + raw_body`, key the app secret. The page's own vector (app key `abcdef`, secret `123`) is in the tests.
// - Lazada: over `app_key + raw_body`, key the app secret (the same construction).
// - Shopee: over `callback_url + "|" + raw_body`, key the partner key; the URL is the exact address the push arrived at, which the API stored with the push (the hook key is kept only as a hash).
// The body is used as BYTES: the bytes are never decoded, re-serialised or trimmed before the signature is checked, and the JSON is read only after the signature passed.
//
// Three verdicts, as for the bank feed hook: `ok` (signed by this connection's app secret, names this connection's shop or seller, fresh); `refused` (the signature is wrong: counted on the hook, ten in an hour stop
// it); `dropped` (nothing to count: the secret cannot be read, the body is not one this reads, or it names ANOTHER shop or seller, as happens when two shops of one own app share the app's one callback address, or its
// time is outside the window). A push is only a hint to poll, so a dropped one costs nothing: the periodic poll makes it up.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { MARKETPLACE_PUSH_ADAPTERS } from '@ludy/kernel-contract';
import { parseLazadaSecret } from './marketplace-lazada.ts';
import { parseShopeeSecret } from './marketplace-shopee.ts';
import { parseTiktokSecret } from './marketplace-tiktok.ts';

export type MarketplacePushVerdict = 'ok' | 'refused' | 'dropped';

// The adapters that take a push are named once, in the contract (the owner's command and the route read the same list).
export type MarketplacePushAdapter = (typeof MARKETPLACE_PUSH_ADAPTERS)[number];
export const isMarketplacePushAdapter = (value: string): value is MarketplacePushAdapter => (MARKETPLACE_PUSH_ADAPTERS as readonly string[]).includes(value);

// A push older than this, or further ahead than the slack, is dropped. A push is only a hint to poll, so a replay costs at most one poll and the dedupe key of the API stops an identical push waiting twice; the
// window is two hours so a captured push cannot be replayed for long after it was claimed, and what a dropped push would have told the worker is made up by the periodic poll.
export const MARKETPLACE_PUSH_MAX_AGE_MS = 2 * 3_600_000;
export const MARKETPLACE_PUSH_FUTURE_SLACK_MS = 10 * 60_000;

export interface MarketplacePush {
  // The `Authorization` header as sent.
  authorization: string;
  // The raw body as received.
  body: Uint8Array;
  // The address the push arrived at, when the API kept it (Shopee).
  requestUrl: string | null;
}

const SHOP_REF = /^[A-Za-z0-9_-]{1,64}$/;
const refOf = (value: unknown): string | null => {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  return typeof value === 'string' && SHOP_REF.test(value) ? value : null;
};

// The signature the platform would send for these bytes, lowercase hex.
export function marketplacePushSignature(adapter: MarketplacePushAdapter, material: { appKey?: string; key: string; requestUrl?: string }, body: Uint8Array): string {
  const mac = createHmac('sha256', material.key);
  if (adapter === 'shopee') mac.update(`${material.requestUrl ?? ''}|`, 'utf8');
  else mac.update(material.appKey ?? '', 'utf8');
  return mac.update(body).digest('hex');
}

// Equal length first (timingSafeEqual throws on unequal lengths), then constant time. A header that is not 64 hex digits can never be a signature. The letter case of the digits holds no secret and a platform may send
// either (Lazada signs its API requests in upper case), so the header is lowercased first: a genuine push is never counted as refused for its case.
function sameSignature(expected: string, given: string): boolean {
  if (!/^[0-9a-fA-F]{64}$/.test(given)) return false;
  return timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(given.toLowerCase(), 'utf8'));
}

// The shop or seller of a connection, from its own sealed secret (never from the push). TikTok: `shopId`; Shopee: `shopId`; Lazada: `sellerId` (written beside the tokens by the authorization, #4285).
function connectionRef(adapter: MarketplacePushAdapter, secret: string): string | null {
  try {
    const value: unknown = JSON.parse(secret);
    if (typeof value !== 'object' || value === null) return null;
    const ref = adapter === 'lazada' ? (value as { sellerId?: unknown }).sellerId : (value as { shopId?: unknown }).shopId;
    return refOf(ref);
  } catch {
    return null;
  }
}

export function verifyMarketplacePush(adapter: string, secret: string, push: MarketplacePush, now: number = Date.now()): MarketplacePushVerdict {
  if (!isMarketplacePushAdapter(adapter)) return 'dropped';
  let signed: string;
  try {
    if (adapter === 'shopee') {
      const credential = parseShopeeSecret(secret);
      // Shopee signs the address too: a push stored without one cannot be checked.
      if (push.requestUrl === null) return 'dropped';
      signed = marketplacePushSignature(adapter, { key: credential.partnerKey, requestUrl: push.requestUrl }, push.body);
    } else if (adapter === 'tiktok_shop') {
      const credential = parseTiktokSecret(secret);
      signed = marketplacePushSignature(adapter, { appKey: credential.appKey, key: credential.appSecret }, push.body);
    } else {
      const credential = parseLazadaSecret(secret);
      signed = marketplacePushSignature(adapter, { appKey: credential.appKey, key: credential.appSecret }, push.body);
    }
  } catch {
    // A secret that cannot be read is the connection's own state, not the push's fault.
    return 'dropped';
  }
  if (!sameSignature(signed, push.authorization)) return 'refused';

  // Signed by this connection's app secret: now, and only now, the body is read. It must name this connection's shop or seller and a fresh time.
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(push.body));
  } catch {
    return 'dropped';
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return 'dropped';
  const named = refOf((body as Record<string, unknown>)[adapter === 'lazada' ? 'seller_id' : 'shop_id']);
  const own = connectionRef(adapter, secret);
  if (named === null || own === null || named !== own) return 'dropped';
  const stamp = (body as Record<string, unknown>).timestamp;
  // TikTok and Shopee send seconds, Lazada milliseconds.
  const at = typeof stamp === 'number' && Number.isFinite(stamp) ? (adapter === 'lazada' ? stamp : stamp * 1000) : Number.NaN;
  if (!(at >= now - MARKETPLACE_PUSH_MAX_AGE_MS && at <= now + MARKETPLACE_PUSH_FUTURE_SLACK_MS)) return 'dropped';
  return 'ok';
}

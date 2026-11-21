// SPDX-License-Identifier: AGPL-3.0-only
// The seller's authorization of a TikTok Shop connection (#2524, S2 = #4269; ADR-0045 point 7): the address of TikTok's consent page, the trade of the one-time code for the token pair, and the choice of the
// shop. It wraps the TikTok provider (T1/T2, #4256 and #4259) with the optional methods of the port that Lazada's wrapper has (marketplace-lazada-authorize.ts); the machinery around it (the one-time state, the
// return page, the worker's `authorize` job, the command that stores the credential and marks the outcome in one transaction) is shared and unchanged. The token API is worker 3's module
// (marketplace-tiktok-token.ts): the token URL carries `app_secret`, so it is built there and nowhere else, and nothing here logs or keeps a token, a code or TikTok's text.
//
// What differs from Lazada: the consent link takes the app's SERVICE ID (a public identifier from Partner Center, kept in the clear like Lazada's App Key), not the App Key; the return address is the one
// registered on the app in Partner Center (not a parameter); and a TikTok app can hold several shops, so after the token is stored the shop list is read and EXACTLY ONE shop is kept (its cipher and id are
// sealed with the connection). None or several fails in words: choosing between shops is a later slice, and guessing would put another shop's orders in the books.
import type { MarketplaceAuthorizeResult, MarketplaceProvider, MarketplaceTestResult } from '@ludy/mod-finance';
import { pickAllowed, type Fetch } from './marketplace-adapter-kit.ts';
import { parseTiktokSecret, tiktokShops, type TiktokCaller } from './marketplace-tiktok.ts';
import { createTiktokToken } from './marketplace-tiktok-token.ts';

// TikTok's consent page for a seller outside the US: `https://services.tiktokshop.com/open/authorize?service_id=...` (Partner Center, "Seller authorization guide"). The state comes back unchanged with the
// code on the return address; the address itself is registered on the app, so it is not sent.
export const TIKTOK_AUTHORIZE_HOST = 'services.tiktokshop.com';
export function tiktokAuthorizeUrl(input: { appKey: string; redirectUri: string; state: string }): string {
  // `appKey` is the port's name for the public id the consent page needs: for TikTok that is the Service ID.
  const query = new URLSearchParams({ service_id: input.appKey, state: input.state });
  return `https://${TIKTOK_AUTHORIZE_HOST}/open/authorize?${query.toString()}`;
}

const keyText = (v: unknown): v is string => typeof v === 'string' && v.length >= 1 && v.length <= 400 && v === v.trim() && /^[\x21-\x7e]+$/.test(v);

// Whether a sealed secret holds an App Key and an App Secret and NO access token yet: the connection the seller typed and has not authorized.
export function isTiktokAwaitingAuthorization(secret: string): boolean {
  try {
    const picked = pickAllowed(JSON.parse(secret), ['appKey', 'appSecret', 'accessToken'] as const);
    return picked !== null && picked.accessToken === undefined && keyText(picked.appKey) && keyText(picked.appSecret);
  } catch {
    return false;
  }
}

export interface TiktokAuthorizeOptions {
  // Bound to the token host by the caller (hostBoundFetch(TIKTOK_TOKEN_HOSTS)); the trade uses no other.
  tokenFetch: Fetch;
  // The signed caller of the provider (bound to the API host): the shop list is read with it right after the token is made.
  caller: TiktokCaller;
  now?: () => Date;
}

export function withTiktokAuthorize(provider: MarketplaceProvider, options: TiktokAuthorizeOptions): MarketplaceProvider {
  return {
    ...provider,
    // The connect form also asks for the app's Service ID, which the consent link needs; it is sealed with the rest and its clear copy is the connection's public id.
    connectFields: ['appKey', 'appSecret', 'serviceId'],
    authorizePublicField: 'serviceId',
    authorizeUrl: tiktokAuthorizeUrl,
    // A key and secret with no token yet: not authorized, said without calling TikTok.
    async testConnection(secret: string): Promise<MarketplaceTestResult> {
      if (isTiktokAwaitingAuthorization(secret)) return 'api_not_enabled';
      return provider.testConnection(secret);
    },
    async authorize(secret: string, code: string): Promise<MarketplaceAuthorizeResult> {
      let keys: { appKey?: unknown; appSecret?: unknown; serviceId?: unknown } | null;
      try {
        keys = pickAllowed(JSON.parse(secret), ['appKey', 'appSecret', 'serviceId'] as const);
      } catch {
        return { refused: 'BAD_SECRET' };
      }
      if (!keys || !keyText(keys.appKey) || !keyText(keys.appSecret)) return { refused: 'BAD_SECRET' };
      const granted = await createTiktokToken({ fetch: options.tokenFetch, ...(options.now ? { now: options.now } : {}) }, { appKey: keys.appKey, appSecret: keys.appSecret, code });
      if ('refused' in granted || 'failed' in granted) return granted;
      // The shop: read with the new token, before anything is stored. Exactly one is kept.
      let shops;
      try {
        shops = await tiktokShops(options.caller, parseTiktokSecret(granted.secret));
      } catch {
        return { failed: 'SHOPS' };
      }
      if (shops.length === 0) return { failed: 'NO_SHOP' };
      if (shops.length > 1) return { failed: 'MANY_SHOPS' };
      const shop = shops[0]!;
      // Only a Vietnam shop with a local seller: a cross-border shop would pass here and then fail every poll without a clear message.
      if (shop.region !== 'VN' || shop.sellerType !== 'LOCAL') return { failed: 'NOT_LOCAL_SHOP' };
      const sealed = { ...(JSON.parse(granted.secret) as Record<string, unknown>), ...(keyText(keys.serviceId) ? { serviceId: keys.serviceId } : {}), shopCipher: shop.cipher, shopId: shop.id };
      // The shop id is the seller reference (#4285): the finance command refuses an authorization onto another shop and keeps the connection as it was.
      return { granted: { secret: JSON.stringify(sealed), accessExpiresAt: granted.accessExpiresAt, refreshExpiresAt: granted.authorizationEndsAt, sellerRef: shop.id } };
    },
  };
}

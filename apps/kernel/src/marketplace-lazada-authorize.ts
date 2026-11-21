// SPDX-License-Identifier: AGPL-3.0-only
// The seller's authorization of a Lazada connection (#2524, S2b = #4238): the address of Lazada's own consent page and the trade of the code it returns for the token pair. It adds the two optional
// methods of the port to the Lazada provider; the API calls only `authorizeUrl` (no secret involved), the worker calls `authorize` with the sealed secret and the code. The token API itself is
// worker 3's module (marketplace-lazada-token.ts); this file holds no call of its own. The state a person's browser carries is made and checked by the finance commands, never here.
import type { MarketplaceAuthorizeResult, MarketplaceProvider } from '@crove/mod-finance';
import { pickAllowed, type Fetch } from './marketplace-adapter-kit.ts';
import { createLazadaToken, LAZADA_AUTH_HOST } from './marketplace-lazada-token.ts';

// Lazada's consent page: `https://auth.lazada.com/oauth/authorize` with the app key as client_id, the return address registered on the app, and `force_auth` so the seller picks the account. The
// parameter names are from the open.lazada.com authorization guide as mirrored (article 108260); that the page returns `state` unchanged is for the live check (#2522).
export function lazadaAuthorizeUrl(input: { appKey: string; redirectUri: string; state: string }): string {
  const query = new URLSearchParams({ response_type: 'code', force_auth: 'true', redirect_uri: input.redirectUri, client_id: input.appKey, state: input.state });
  return `https://${LAZADA_AUTH_HOST}/oauth/authorize?${query.toString()}`;
}

export interface LazadaAuthorizeOptions {
  // Bound to the token hosts by the caller (hostBoundFetch(LAZADA_TOKEN_HOSTS)); the trade uses no other.
  tokenFetch: Fetch;
  now?: () => Date;
}

export function withLazadaAuthorize(provider: MarketplaceProvider, options: LazadaAuthorizeOptions): MarketplaceProvider {
  return {
    ...provider,
    authorizeUrl: lazadaAuthorizeUrl,
    async authorize(secret: string, code: string): Promise<MarketplaceAuthorizeResult> {
      let keys: { appKey?: unknown; appSecret?: unknown } | null;
      try {
        keys = pickAllowed(JSON.parse(secret), ['appKey', 'appSecret'] as const);
      } catch {
        return { refused: 'BAD_SECRET' };
      }
      if (!keys || typeof keys.appKey !== 'string' || typeof keys.appSecret !== 'string') return { refused: 'BAD_SECRET' };
      const result = await createLazadaToken({ fetch: options.tokenFetch, ...(options.now ? { now: options.now } : {}) }, { appKey: keys.appKey, appSecret: keys.appSecret, code });
      if ('refused' in result || 'failed' in result) return result;
      return { granted: { secret: result.secret, accessExpiresAt: result.accessExpiresAt, refreshExpiresAt: result.refreshExpiresAt, sellerRef: result.sellerId } };
    },
  };
}

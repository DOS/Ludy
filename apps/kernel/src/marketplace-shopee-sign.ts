// SPDX-License-Identifier: AGPL-3.0-only
// How Shopee signs an Open API v2 request (#2524, S1 = #4274), from the OFFICIAL guide page "Authorization and Authentication" (open.shopee.com/developer-guide/16, read 2026-11-21): HMAC-SHA256 with the
// partner key as the key, over a base string made of the partner id, the API path (without the host), the timestamp and, for a shop call, the access token and the shop id, all concatenated with no
// separator; the signature is the lower-case hex of the digest. A public call (and the two token calls) signs only the first three. The signature, the partner id, the timestamp, the access token and
// the shop id travel as QUERY parameters and the body is not signed. The timestamp is a count of SECONDS and is valid for five minutes.
//
// A pure function: no clock, no key kept, nothing logged. The fake server of the tests checks it against its own implementation of the same rule.
import { createHmac } from 'node:crypto';

export interface ShopeeShopScope {
  accessToken: string;
  shopId: string;
}

// `scope` is given for a shop call and left out for a public call or a token call.
export function signShopeeRequest(partnerKey: string, partnerId: string, path: string, timestamp: number, scope?: ShopeeShopScope): string {
  const base = `${partnerId}${path}${timestamp}${scope ? `${scope.accessToken}${scope.shopId}` : ''}`;
  return createHmac('sha256', partnerKey).update(base, 'utf8').digest('hex');
}

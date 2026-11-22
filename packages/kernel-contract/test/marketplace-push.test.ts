// SPDX-License-Identifier: AGPL-3.0-only
// The push address of a marketplace connection (#4348, S3b of #4315): the one function that builds it and the shapes of the command and the status.
import { describe, expect, it } from 'vitest';
import { MARKETPLACE_HOOK_KEY_LENGTH, MARKETPLACE_PUSH_ADAPTERS, marketplaceHookAddress, marketplaceHookBaseUsable, zMarketplacePushHookCreated, zMarketplacePushHookSet, zMarketplacePushHookStatus } from '../src/marketplace-connections.ts';

const KEY = 'AbCdEfGhIjKlMnOpQrStUv';
const ID = '11111111-1111-4111-8111-111111111111';

describe('marketplace push address', () => {
  it('is the configured public URL, the adapter and the key, with trailing slashes of the URL dropped', () => {
    expect(KEY).toHaveLength(MARKETPLACE_HOOK_KEY_LENGTH);
    expect(marketplaceHookAddress('https://api.example.test', 'shopee', KEY)).toBe(`https://api.example.test/api/marketplace/shopee/webhook/${KEY}`);
    expect(marketplaceHookAddress('https://api.example.test//', 'tiktok_shop', KEY)).toBe(`https://api.example.test/api/marketplace/tiktok_shop/webhook/${KEY}`);
    // A long run of slashes is cut in linear time (no backtracking), and a path before them is kept.
    expect(marketplaceHookAddress(`https://api.example.test/ludy${'/'.repeat(100_000)}`, 'shopee', KEY)).toBe(`https://api.example.test/ludy/api/marketplace/shopee/webhook/${KEY}`);
    expect(marketplaceHookAddress('/'.repeat(10), 'shopee', KEY)).toBe(`/api/marketplace/shopee/webhook/${KEY}`);
  });

  it('offers an address only on an https URL a platform can reach: not the localhost default, a loopback address, plain http, a query or a fragment, or nothing', () => {
    for (const ok of ['https://api.example.test', 'https://api.example.test/', 'https://api.example.test/base', 'https://ludy.example.vn:8443']) expect(marketplaceHookBaseUsable(ok), ok).toBe(true);
    for (const bad of [undefined, '', 'not a url', 'http://api.example.test', 'http://localhost:3000', 'https://localhost', 'https://app.localhost', 'https://127.0.0.1', 'https://[::1]', 'https://api.example.test/?a=1', 'https://api.example.test/#x', 'ftp://api.example.test']) {
      expect(marketplaceHookBaseUsable(bad), String(bad)).toBe(false);
    }
  });

  it('names the three platforms that push and takes only a connection id to make or read an address', () => {
    expect([...MARKETPLACE_PUSH_ADAPTERS].sort()).toEqual(['lazada', 'shopee', 'tiktok_shop']);
    expect(zMarketplacePushHookSet.safeParse({ id: ID }).success).toBe(true);
    expect(zMarketplacePushHookSet.safeParse({ id: ID, key: KEY }).success).toBe(false);
    expect(zMarketplacePushHookSet.safeParse({ id: 'nope' }).success).toBe(false);
  });

  it('answers the address once with no key field, and a status with no address or key', () => {
    expect(zMarketplacePushHookCreated.safeParse({ adapter: 'shopee', address: marketplaceHookAddress('https://api.example.test', 'shopee', KEY), created: true }).success).toBe(true);
    expect(zMarketplacePushHookCreated.safeParse({ adapter: 'sandbox', address: 'https://x', created: true }).success).toBe(false);
    expect(zMarketplacePushHookCreated.safeParse({ adapter: 'shopee', address: 'https://x', created: true, key: KEY }).success).toBe(false);
    const status = { exists: true, createdAt: null, rotatedAt: null, lastSeenAt: null, rejectedCount: 0, stopped: false };
    expect(zMarketplacePushHookStatus.safeParse(status).success).toBe(true);
    expect(zMarketplacePushHookStatus.safeParse({ ...status, address: 'https://x' }).success).toBe(false);
  });
});

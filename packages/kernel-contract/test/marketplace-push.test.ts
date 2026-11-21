// SPDX-License-Identifier: AGPL-3.0-only
// The push address of a marketplace connection (#4348, S3b of #4315): the one function that builds it and the shapes of the command and the status.
import { describe, expect, it } from 'vitest';
import { MARKETPLACE_HOOK_KEY_LENGTH, MARKETPLACE_PUSH_ADAPTERS, marketplaceHookAddress, zMarketplacePushHookCreated, zMarketplacePushHookSet, zMarketplacePushHookStatus } from '../src/marketplace-connections.ts';

const KEY = 'AbCdEfGhIjKlMnOpQrStUv';
const ID = '11111111-1111-4111-8111-111111111111';

describe('marketplace push address', () => {
  it('is the configured public URL, the adapter and the key, with trailing slashes of the URL dropped', () => {
    expect(KEY).toHaveLength(MARKETPLACE_HOOK_KEY_LENGTH);
    expect(marketplaceHookAddress('https://api.example.test', 'shopee', KEY)).toBe(`https://api.example.test/api/marketplace/shopee/webhook/${KEY}`);
    expect(marketplaceHookAddress('https://api.example.test//', 'tiktok_shop', KEY)).toBe(`https://api.example.test/api/marketplace/tiktok_shop/webhook/${KEY}`);
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

// SPDX-License-Identifier: AGPL-3.0-only
// The API's half of a marketplace push (#4346, S2 of #4315), without a database: the address a seller pastes and Shopee signs, the dedupe key, and the order of the checks in acceptMarketplacePush with a runtime whose
// `orgless` answers what the two definers would (the lookup, then the put). The route and the stored row are in marketplace-hook.db.test.ts, which needs a PostgreSQL.
import type { Runtime } from '@ludy/kernel-runtime';
import { describe, expect, it } from 'vitest';
import { MARKETPLACE_HOOK_KEY_LENGTH, acceptMarketplacePush, marketplaceHookAddress, marketplaceHookKeyHash, marketplacePushDedupeKey } from '../src/marketplace-push-hook.ts';

const KEY = 'AbCdEfGhIjKlMnOpQrStUv';
const BODY = new TextEncoder().encode('{"shop_id":"1"}');
const HEADER = 'a'.repeat(64);
const PUBLIC = 'https://api.example.test';

// A runtime whose orgless calls answer from a list, in order, and are counted.
function runtimeOf(...answers: unknown[]): { runtime: Runtime; calls: () => number } {
  let used = 0;
  const runtime = { orgless: async () => answers[used++] } as unknown as Runtime;
  return { runtime, calls: () => used };
}
const budgetOf = (allowed: boolean) => {
  const taken: string[] = [];
  return { take: (key: string) => (taken.push(key), { allowed, retryAfterSeconds: 1 }), taken };
};

describe('marketplace push, the address and the dedupe key', () => {
  it('builds the address from the configured public URL, the adapter and the key, and nothing else', () => {
    expect(KEY).toHaveLength(MARKETPLACE_HOOK_KEY_LENGTH);
    expect(marketplaceHookAddress(PUBLIC, 'shopee', KEY)).toBe(`https://api.example.test/api/marketplace/shopee/webhook/${KEY}`);
    // Trailing slashes of the configured value do not double up; a path in it is kept.
    expect(marketplaceHookAddress(`${PUBLIC}//`, 'tiktok_shop', KEY)).toBe(`https://api.example.test/api/marketplace/tiktok_shop/webhook/${KEY}`);
    expect(marketplaceHookAddress(`${PUBLIC}/ludy/`, 'shopee', KEY)).toBe(`https://api.example.test/ludy/api/marketplace/shopee/webhook/${KEY}`);
  });

  it('hashes the key to a lowercase SHA-256 hex and dedupes on the header and every byte of the body', () => {
    expect(marketplaceHookKeyHash(KEY)).toMatch(/^[0-9a-f]{64}$/);
    const base = marketplacePushDedupeKey(HEADER, BODY);
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(marketplacePushDedupeKey(HEADER, BODY)).toBe(base);
    expect(marketplacePushDedupeKey(`${HEADER}0`, BODY)).not.toBe(base);
    expect(marketplacePushDedupeKey(HEADER, new Uint8Array([...BODY, 0x20]))).not.toBe(base);
    // The header and the body are separated: moving a byte from one to the other is another push.
    expect(marketplacePushDedupeKey('ab', new TextEncoder().encode('c'))).not.toBe(marketplacePushDedupeKey('a', new TextEncoder().encode('bc')));
  });
});

describe('acceptMarketplacePush', () => {
  const hook = { hookId: '11111111-1111-4111-8111-111111111111', standing: 'ok' };
  const request = (over: Partial<{ key: string; authorization: string | undefined; body: Uint8Array }> = {}) => ({ key: KEY, authorization: HEADER, body: BODY, ...over });

  it('looks nothing up for a key or an adapter of the wrong shape', async () => {
    const { runtime, calls } = runtimeOf();
    expect(await acceptMarketplacePush(runtime, 'shopee', request({ key: 'short' }), budgetOf(true), PUBLIC)).toEqual({ status: 404 });
    expect(await acceptMarketplacePush(runtime, 'shopee', request({ key: `${KEY}!` }), budgetOf(true), PUBLIC)).toEqual({ status: 404 });
    expect(await acceptMarketplacePush(runtime, 'Shopee/..', request(), budgetOf(true), PUBLIC)).toEqual({ status: 404 });
    expect(calls()).toBe(0);
  });

  it('answers 404 for a key with no hook and stores nothing', async () => {
    const { runtime, calls } = runtimeOf(null);
    expect(await acceptMarketplacePush(runtime, 'shopee', request(), budgetOf(true), PUBLIC)).toEqual({ status: 404 });
    expect(calls()).toBe(1);
  });

  it('answers an empty 200 without a put for a stopped hook, a missing, odd or over long header, an empty body and a body over the cap', async () => {
    const stopped = runtimeOf({ ...hook, standing: 'stopped' });
    expect(await acceptMarketplacePush(stopped.runtime, 'shopee', request(), budgetOf(true), PUBLIC)).toEqual({ status: 200 });
    expect(stopped.calls()).toBe(1);
    for (const over of [{ authorization: undefined }, { authorization: '' }, { authorization: 'x'.repeat(257) }, { authorization: 'a\nb' }, { body: new Uint8Array(0) }, { body: new Uint8Array(16 * 1024 + 1) }]) {
      const { runtime, calls } = runtimeOf(hook);
      expect(await acceptMarketplacePush(runtime, 'shopee', request(over), budgetOf(true), PUBLIC)).toEqual({ status: 200 });
      expect(calls()).toBe(1);
    }
  });

  it('drops a push of a hook over its budget with an empty 200, never a 429, and asks the budget by the hook id', async () => {
    const { runtime, calls } = runtimeOf(hook);
    const budget = budgetOf(false);
    expect(await acceptMarketplacePush(runtime, 'shopee', request(), budget, PUBLIC)).toEqual({ status: 200 });
    expect(budget.taken).toEqual([hook.hookId]);
    expect(calls()).toBe(1);
  });

  it('answers an empty 200 for accepted, duplicate and busy, and 404 for a hook that is gone', async () => {
    for (const [put, status] of [['accepted', 200], ['duplicate', 200], ['busy', 200], ['gone', 404]] as const) {
      const { runtime, calls } = runtimeOf(hook, put);
      expect(await acceptMarketplacePush(runtime, 'tiktok_shop', request(), budgetOf(true), PUBLIC)).toEqual({ status });
      expect(calls()).toBe(2);
    }
  });
});

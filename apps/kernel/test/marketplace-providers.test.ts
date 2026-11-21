// SPDX-License-Identifier: AGPL-3.0-only
// Which marketplace adapters a deployment offers (#2519, #4238): only the ones MARKETPLACE_PROVIDERS names, and an id this build does not know offers nothing.
import { describe, expect, it } from 'vitest';
import { marketplaceProvidersOf } from '../src/kernel.ts';
import { LAZADA_HOSTS } from '../src/marketplace-lazada.ts';
import { TIKTOK_HOSTS } from '../src/marketplace-tiktok.ts';

const offered = (list: string) => Object.keys(marketplaceProvidersOf({ MARKETPLACE_PROVIDERS: list })).sort();

describe('marketplaceProvidersOf', () => {
  it('offers nothing unless an adapter is named, and Lazada only when it is named', () => {
    expect(offered('')).toEqual([]);
    expect(offered('lazada')).toEqual(['lazada']);
    expect(offered(' sandbox , lazada ')).toEqual(['lazada', 'sandbox']);
    expect(offered('sandbox')).toEqual(['sandbox']);
    expect(offered('lazadaa,shopee,,')).toEqual([]);
  });

  it('offers TikTok Shop only when it is named, bound to its own host, with the Service ID to type (#4269)', () => {
    expect(offered('tiktok_shop')).toEqual(['tiktok_shop']);
    expect(offered('lazada, tiktok_shop')).toEqual(['lazada', 'tiktok_shop']);
    expect(offered('tiktok')).toEqual([]);
    const tiktok = marketplaceProvidersOf({ MARKETPLACE_PROVIDERS: 'tiktok_shop' }).tiktok_shop;
    expect(tiktok?.hosts).toEqual([...TIKTOK_HOSTS]);
    expect(tiktok?.connectFields).toEqual(['appKey', 'appSecret', 'serviceId']);
    expect(tiktok?.authorizePublicField).toBe('serviceId');
    expect(typeof tiktok?.authorizeUrl).toBe('function');
    expect(typeof tiktok?.authorize).toBe('function');
    expect(Object.keys(tiktok?.capabilities.platforms ?? {})).toEqual(['tiktok_shop']);
  });

  it('builds Lazada bound to its own host and serving only its own platform, with the App Key and Secret to type', () => {
    const lazada = marketplaceProvidersOf({ MARKETPLACE_PROVIDERS: 'lazada' }).lazada;
    expect(lazada?.hosts).toEqual([...LAZADA_HOSTS]);
    expect(lazada?.connectFields).toEqual(['appKey', 'appSecret']);
    expect(Object.keys(lazada?.capabilities.platforms ?? {})).toEqual(['lazada']);
  });
});

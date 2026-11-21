// SPDX-License-Identifier: AGPL-3.0-only
// Which marketplace adapters a deployment offers (#2519, #4238): only the ones MARKETPLACE_PROVIDERS names, and an id this build does not know offers nothing.
import { describe, expect, it } from 'vitest';
import { marketplaceProvidersOf } from '../src/kernel.ts';
import { LAZADA_HOSTS } from '../src/marketplace-lazada.ts';

const offered = (list: string) => Object.keys(marketplaceProvidersOf({ MARKETPLACE_PROVIDERS: list })).sort();

describe('marketplaceProvidersOf', () => {
  it('offers nothing unless an adapter is named, and Lazada only when it is named', () => {
    expect(offered('')).toEqual([]);
    expect(offered('lazada')).toEqual(['lazada']);
    expect(offered(' sandbox , lazada ')).toEqual(['lazada', 'sandbox']);
    expect(offered('sandbox')).toEqual(['sandbox']);
    expect(offered('lazadaa,shopee,,')).toEqual([]);
  });

  it('builds Lazada bound to its own host and serving only its own platform, with the App Key and Secret to type', () => {
    const lazada = marketplaceProvidersOf({ MARKETPLACE_PROVIDERS: 'lazada' }).lazada;
    expect(lazada?.hosts).toEqual([...LAZADA_HOSTS]);
    expect(lazada?.connectFields).toEqual(['appKey', 'appSecret']);
    expect(Object.keys(lazada?.capabilities.platforms ?? {})).toEqual(['lazada']);
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
// Which marketplace adapters a deployment offers (#2519, #4238): only the ones MARKETPLACE_PROVIDERS names, and an id this build does not know offers nothing.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { marketplaceProvidersOf } from '../src/kernel.ts';
import { LAZADA_HOSTS } from '../src/marketplace-lazada.ts';
import { TIKTOK_HOSTS } from '../src/marketplace-tiktok.ts';

const offered = (list: string) => Object.keys(marketplaceProvidersOf({ MARKETPLACE_PROVIDERS: list })).sort();
const BASE = { DATABASE_URL: 'postgres://localhost/x', AUTH_JWT_SECRET: 'unit-test-jwt-secret-0123456789abcdef', AUTH_ISSUER: 'crove-auth' };

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

  it('gates Lazada income reading behind MARKETPLACE_INCOME_PROVIDERS (#4306)', () => {
    expect(marketplaceProvidersOf({ MARKETPLACE_PROVIDERS: 'lazada' }).lazada?.listIncome).toBeUndefined();
    expect(marketplaceProvidersOf({ MARKETPLACE_PROVIDERS: 'lazada', MARKETPLACE_INCOME_PROVIDERS: '' }).lazada?.listIncome).toBeUndefined();
    expect(marketplaceProvidersOf({ MARKETPLACE_PROVIDERS: 'lazada', MARKETPLACE_INCOME_PROVIDERS: 'tiktok_shop,sandbox' }).lazada?.listIncome).toBeUndefined();
    expect(typeof marketplaceProvidersOf({ MARKETPLACE_PROVIDERS: 'lazada', MARKETPLACE_INCOME_PROVIDERS: 'lazada' }).lazada?.listIncome).toBe('function');
    expect(typeof marketplaceProvidersOf({ MARKETPLACE_PROVIDERS: 'lazada', MARKETPLACE_INCOME_PROVIDERS: ' tiktok_shop , lazada ' }).lazada?.listIncome).toBe('function');
    expect(loadConfig({ ...BASE }).MARKETPLACE_INCOME_PROVIDERS).toBe('');
    expect(loadConfig({ ...BASE, MARKETPLACE_INCOME_PROVIDERS: 'lazada' }).MARKETPLACE_INCOME_PROVIDERS).toBe('lazada');
    expect(() => loadConfig({ ...BASE, MARKETPLACE_INCOME_PROVIDERS: 'not valid!' })).toThrow();
    const compose = readFileSync(fileURLToPath(new URL('../../../docker-compose.yml', import.meta.url)), 'utf8');
    expect(compose).toContain('MARKETPLACE_INCOME_PROVIDERS: ${MARKETPLACE_INCOME_PROVIDERS:-}');
    const example = readFileSync(fileURLToPath(new URL('../../../.env.example', import.meta.url)), 'utf8');
    expect(example).toMatch(/^MARKETPLACE_INCOME_PROVIDERS=$/m);
  });
});

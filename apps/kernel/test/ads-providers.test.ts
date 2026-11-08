// SPDX-License-Identifier: AGPL-3.0-only
// The write connection's provider ids and scopes live in two places that cannot import each other (@crove/ad-platform depends on the
// channel layer only, the contract on neither): the contract's constants (AD_WRITE_PROVIDERS, ADS_SPEND_SCOPES, READ_PROVIDER_OF_WRITE)
// and the adapters' own. This is the one place that depends on both, and keeps them equal (ADR-0043, #2294, W0b).
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { adPlatformsOf, channelConnectors, metaWriteAppShared } from '../src/kernel.ts';
import { META_FORBIDDEN_SCOPES, META_WRITE_PROVIDER, META_WRITE_SCOPES, SANDBOX_WRITE_PROVIDER, SANDBOX_WRITE_SCOPES } from '@crove/ad-platform';
import { ADS_SPEND_SCOPES, AD_WRITE_PROVIDERS, READ_PROVIDER_OF_WRITE, isAdProviderId, isAdWriteProviderId } from '@crove/kernel-contract';

describe('the write providers of running ads', () => {
  it('are the adapters’ own, each an ad provider id whose read provider is registered', () => {
    expect([...AD_WRITE_PROVIDERS].sort()).toEqual([META_WRITE_PROVIDER, SANDBOX_WRITE_PROVIDER].sort());
    for (const provider of AD_WRITE_PROVIDERS) {
      expect(isAdProviderId(provider), provider).toBe(true);
      expect(isAdWriteProviderId(provider), provider).toBe(true);
      expect(isAdWriteProviderId(READ_PROVIDER_OF_WRITE[provider]), provider).toBe(false);
      expect(isAdProviderId(READ_PROVIDER_OF_WRITE[provider]), provider).toBe(true);
    }
    expect(READ_PROVIDER_OF_WRITE).toEqual({ metawrite_ads: 'meta_ads', sandboxwrite_ads: 'sandbox_ads' });
  });

  // The database guard (crove_ads.write_connection_guard) names the twin of an account's provider by a rule, not a list: the write
  // provider of `<x>_ads` is `<x>write_ads`. A provider that breaks the rule would be refused at every attaching.
  it('follow the rule the database guard uses to name the write twin of a read provider', () => {
    for (const provider of AD_WRITE_PROVIDERS) {
      const read = READ_PROVIDER_OF_WRITE[provider];
      expect(read.endsWith('_ads'), read).toBe(true);
      expect(`${read.slice(0, -4)}write_ads`, read).toBe(provider);
    }
  });

  // The reading connector refuses these while running ads is off, and the switch-off closes a connection that holds one: one list.
  it('keep the permissions the reading connector refuses equal to the contract’s spend-capable ones', () => {
    expect([...META_FORBIDDEN_SCOPES].sort()).toEqual([...ADS_SPEND_SCOPES].sort());
  });

  it('ask for the permission that can change campaigns, which the contract counts as spend-capable', () => {
    for (const scopes of [META_WRITE_SCOPES, SANDBOX_WRITE_SCOPES]) {
      expect(scopes).toContain('ads_read');
      expect(scopes.some((scope) => (ADS_SPEND_SCOPES as readonly string[]).includes(scope))).toBe(true);
    }
  });
});

// Whether the deployment's write Meta app is the read ads app or the Pages app decides how far switching running ads off closes the Meta
// reading connections (ADR-0043 point 4): the same app means a person's reading tokens can hold the permission, an app of its own means they
// cannot, and no write app means no write connection to make.
describe('whether the write Meta app is shared', () => {
  it('is shared when it has the id of the read ads app or of the Pages app, and not with an app of its own or none', () => {
    const config = (write: string | undefined, ads: string | undefined, pages: string | undefined) => ({ CHANNEL_META_ADS_WRITE_APP_ID: write, CHANNEL_META_ADS_APP_ID: ads, CHANNEL_META_APP_ID: pages });
    expect(metaWriteAppShared(config('1', '1', undefined))).toBe(true);
    expect(metaWriteAppShared(config('1', '2', '1'))).toBe(true);
    expect(metaWriteAppShared(config('1', '1', '1'))).toBe(true);
    expect(metaWriteAppShared(config('1', '2', '3'))).toBe(false);
    expect(metaWriteAppShared(config('1', undefined, undefined))).toBe(false);
    expect(metaWriteAppShared(config(undefined, '1', '1'))).toBe(false);
  });
});

describe('Google Ads configuration and wiring (#2220)', () => {
  const baseEnv = {
    DATABASE_URL: 'postgres://u:p@localhost:5432/ludy',
    PUBLIC_URL: 'http://localhost:8787',
    AUTH_ISSUER: 'http://localhost:9999/auth/v1',
    AUTH_JWT_SECRET: 'a'.repeat(32),
    AUTH_UPSTREAM_URL: 'http://localhost:9999',
  };
  const validClientId = '123456789012-abcdef0123456789.apps.googleusercontent.com';

  it('requires both CHANNEL_GOOGLE_ADS_CLIENT_ID and CHANNEL_GOOGLE_ADS_CLIENT_SECRET or neither, and checks the Google web client id format', () => {
    expect(() => loadConfig({ ...baseEnv, CHANNEL_GOOGLE_ADS_CLIENT_ID: validClientId })).toThrow(
      'set both CHANNEL_GOOGLE_ADS_CLIENT_ID and CHANNEL_GOOGLE_ADS_CLIENT_SECRET, or neither',
    );
    expect(() => loadConfig({ ...baseEnv, CHANNEL_GOOGLE_ADS_CLIENT_SECRET: 'secret-1' })).toThrow(
      'set both CHANNEL_GOOGLE_ADS_CLIENT_ID and CHANNEL_GOOGLE_ADS_CLIENT_SECRET, or neither',
    );
    expect(() =>
      loadConfig({
        ...baseEnv,
        CHANNEL_GOOGLE_ADS_CLIENT_ID: 'not-a-google-client-id',
        CHANNEL_GOOGLE_ADS_CLIENT_SECRET: 'secret-1',
      }),
    ).toThrow('CHANNEL_GOOGLE_ADS_CLIENT_ID is the client id of a Google OAuth web client');
  });

  it('registers google_ads in adPlatformsOf and channelConnectors only when both Google Ads OAuth credentials are set', () => {
    const unconfigured = loadConfig(baseEnv);
    expect(Object.keys(adPlatformsOf(unconfigured))).not.toContain('google_ads');
    expect(Object.keys(channelConnectors(unconfigured))).not.toContain('google_ads');

    const configured = loadConfig({
      ...baseEnv,
      CHANNEL_GOOGLE_ADS_CLIENT_ID: validClientId,
      CHANNEL_GOOGLE_ADS_CLIENT_SECRET: 'secret-1',
    });
    expect(Object.keys(adPlatformsOf(configured))).toContain('google_ads');
    expect(adPlatformsOf(configured).google_ads?.capabilities.resultKinds).toEqual(['conversion']);
    expect(Object.keys(channelConnectors(configured))).toContain('google_ads');
  });
});


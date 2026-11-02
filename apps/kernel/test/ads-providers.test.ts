// SPDX-License-Identifier: AGPL-3.0-only
// The write connection's provider ids and scopes live in two places that cannot import each other (@crove/ad-platform depends on the
// channel layer only, the contract on neither): the contract's constants (AD_WRITE_PROVIDERS, ADS_SPEND_SCOPES, READ_PROVIDER_OF_WRITE)
// and the adapters' own. This is the one place that depends on both, and keeps them equal (ADR-0043, #2294, W0b).
import { describe, expect, it } from 'vitest';
import { META_WRITE_PROVIDER, META_WRITE_SCOPES, SANDBOX_WRITE_PROVIDER, SANDBOX_WRITE_SCOPES } from '@crove/ad-platform';
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

  it('ask for the permission that can change campaigns, which the contract counts as spend-capable', () => {
    for (const scopes of [META_WRITE_SCOPES, SANDBOX_WRITE_SCOPES]) {
      expect(scopes).toContain('ads_read');
      expect(scopes.some((scope) => (ADS_SPEND_SCOPES as readonly string[]).includes(scope))).toBe(true);
    }
  });
});

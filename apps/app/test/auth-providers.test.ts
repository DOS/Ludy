// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { offeredProviders, providerLabel } from '../src/lib/auth-providers.ts';

describe('sign-in provider buttons', () => {
  it('offers well-formed ids once each and nothing from an older server', () => {
    expect(offeredProviders(undefined)).toEqual([]);
    expect(offeredProviders(['google', 'github', 'google'])).toEqual(['google', 'github']);
    expect(offeredProviders(['Google', 'x', '1a', 'bad id', '../x', 'ok_1'])).toEqual(['x', 'ok_1']);
    expect(offeredProviders(Array.from({ length: 20 }, (_, i) => `p${i}x`))).toHaveLength(12);
  });

  it('names the known providers and words the others from their id', () => {
    expect(providerLabel('github')).toBe('GitHub');
    expect(providerLabel('azure')).toBe('Microsoft');
    expect(providerLabel('steam')).toBe('Steam');
    expect(providerLabel('some_new_one')).toBe('Some new one');
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
// PUBLIC_URL is the origin Shopee's push address is built from (#4346): the address is stored with each Shopee push and a definer refuses one of over 400 characters, so a PUBLIC_URL too long for it is refused at boot.
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { MARKETPLACE_HOOK_KEY_LENGTH, marketplaceHookAddress } from '../src/marketplace-push-hook.ts';

const BASE = { DATABASE_URL: 'postgres://localhost/x', AUTH_JWT_SECRET: 'x'.repeat(32), AUTH_ISSUER: 'crove-auth', AUTH_SESSION_CHECK: 'jwt', PUBLIC_AUTH_URL: 'https://auth.example.test', WEB_DIST: '/nonexistent' };
// The longest address the definer takes (marketplace_hook_put_notice: 1 to 400 characters).
const DEFINER_ADDRESS_MAX = 400;
const url = (length: number) => `https://${'a'.repeat(length - 'https://'.length)}`;

describe('PUBLIC_URL length', () => {
  it('takes a URL of 340 characters and builds a push address the definer accepts from it, even with trailing slashes', () => {
    const longest = url(340);
    expect(loadConfig({ ...BASE, PUBLIC_URL: longest }).PUBLIC_URL).toBe(longest);
    const key = 'k'.repeat(MARKETPLACE_HOOK_KEY_LENGTH);
    expect(marketplaceHookAddress(longest, 'shopee', key).length).toBeLessThanOrEqual(DEFINER_ADDRESS_MAX);
    expect(marketplaceHookAddress(`${longest}///`, 'shopee', key).length).toBeLessThanOrEqual(DEFINER_ADDRESS_MAX);
  });

  it('refuses a URL of 341 characters at boot, and keeps the default when none is set', () => {
    expect(() => loadConfig({ ...BASE, PUBLIC_URL: url(341) })).toThrow(/PUBLIC_URL/);
    expect(loadConfig({ ...BASE }).PUBLIC_URL).toBe('http://localhost:8080');
  });
});

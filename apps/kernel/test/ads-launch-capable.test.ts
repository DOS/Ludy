// SPDX-License-Identifier: AGPL-3.0-only
// The approval card asks whether this deployment can launch on an account's provider (#3675). It must follow adWritersOf exactly: the sandbox's writer with
// ADS_SANDBOX, Meta's only with the write app secret AND ADS_LIVE_LAUNCH (off by default, refused on a public deployment), and the answer holds no secret.
import { describe, expect, it } from 'vitest';
import { adLaunchCapable } from '../src/ads-launch-capable.ts';
import { adWritersOf } from '../src/kernel.ts';

const config = (over: Record<string, string | undefined>) => ({ ADS_SANDBOX: 'false', ADS_LIVE_LAUNCH: 'false', CHANNEL_META_ADS_WRITE_APP_SECRET: undefined, CHANNEL_META_GRAPH_VERSION: undefined, ...over }) as unknown as Parameters<typeof adWritersOf>[0];
const providersOf = (over: Record<string, string | undefined>) => Object.keys(adWritersOf(config(over)));

describe('adLaunchCapable (#3675)', () => {
  it('is false for Meta while ADS_LIVE_LAUNCH is off, even with the write app secret, and true once it is on', () => {
    expect(adLaunchCapable(providersOf({ CHANNEL_META_ADS_WRITE_APP_SECRET: 'x'.repeat(32) }), 'meta_ads')).toBe(false);
    expect(adLaunchCapable(providersOf({ ADS_LIVE_LAUNCH: 'true' }), 'meta_ads')).toBe(false);
    expect(adLaunchCapable(providersOf({ ADS_LIVE_LAUNCH: 'true', CHANNEL_META_ADS_WRITE_APP_SECRET: 'x'.repeat(32) }), 'meta_ads')).toBe(true);
  });

  it('is true for the sandbox account only where ADS_SANDBOX is on, and never crosses providers', () => {
    expect(adLaunchCapable(providersOf({}), 'sandbox_ads')).toBe(false);
    const sandbox = providersOf({ ADS_SANDBOX: 'true' });
    expect(adLaunchCapable(sandbox, 'sandbox_ads')).toBe(true);
    expect(adLaunchCapable(sandbox, 'meta_ads')).toBe(false);
  });

  it('is false for every account, known or not, when the deployment has no launch writer at all', () => {
    expect(adLaunchCapable([], null)).toBe(false);
    expect(adLaunchCapable([], 'meta_ads')).toBe(false);
    expect(adLaunchCapable(providersOf({}), null)).toBe(false);
  });

  it('claims nothing when the account is not known to the caller, and ignores a provider id that is not a write provider', () => {
    expect(adLaunchCapable(['sandboxwrite_ads'], null)).toBeNull();
    expect(adLaunchCapable(['sandbox_ads', 'nonsense'], 'sandbox_ads')).toBe(false);
  });
});

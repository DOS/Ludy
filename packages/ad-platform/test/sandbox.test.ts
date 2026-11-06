// SPDX-License-Identifier: AGPL-3.0-only
// The offline sandbox ad platform (ADR-0040): its logins, the one account each reaches, the daily rows it reports (the same
// figures every time for a settled day, a drift inside the revision window), and its refusals.
import { describe, expect, it } from 'vitest';
import { AD_PLATFORM_PROVIDERS, AdPlatformError, adPlatforms, isAdPlatformProvider, sandboxAdPlatform } from '../src/index.ts';

const at = (iso: string) => () => new Date(iso);

describe('the sandbox ad platform', () => {
  it('connects an account of its own each time, with a secret the kernel seals', () => {
    const platform = sandboxAdPlatform();
    const a = platform.connect({ displayName: 'Quảng cáo thử' });
    const b = platform.connect({ displayName: 'Quảng cáo thử' });
    expect(a).toMatchObject({ provider: 'sandbox_ads', displayName: 'Quảng cáo thử' });
    expect(a.externalAccountId).toMatch(/^sbxads-[0-9a-f]{16}$/);
    expect(a.externalAccountId).not.toBe(b.externalAccountId);
    expect(a.secret).not.toBe(b.secret);
    expect(platform.hosts).toEqual([]);
    expect(AD_PLATFORM_PROVIDERS).toContain(platform.id);
    expect(isAdPlatformProvider('sandbox_ads')).toBe(true);
    expect(isAdPlatformProvider('sandbox')).toBe(false);
    expect(Object.keys(adPlatforms({ sandbox: true }))).toEqual(['sandbox_ads']);
    expect(adPlatforms({ sandbox: false })).toEqual({});
  });

  it('makes the same account again for the same key, and another for any other', () => {
    const platform = sandboxAdPlatform();
    const a = platform.connect({ displayName: 'a', key: 'request-1' });
    const b = platform.connect({ displayName: 'a', key: 'request-1' });
    const c = platform.connect({ displayName: 'a', key: 'request-2' });
    expect(a.externalAccountId).toBe(b.externalAccountId);
    expect(a.secret).not.toBe(b.secret);
    expect(c.externalAccountId).not.toBe(a.externalAccountId);
    expect(() => platform.connect({ displayName: 'a', key: 'bad key!' })).toThrow('invalid key');
  });

  it('reaches one account, in dong in Ho Chi Minh City or in dollars in Los Angeles', async () => {
    const platform = sandboxAdPlatform();
    const vnd = platform.connect({ displayName: 'a' });
    const usd = platform.connect({ displayName: 'b', currency: 'USD' });
    expect(await platform.accounts(vnd.secret)).toEqual([
      { externalAccountId: vnd.externalAccountId, displayName: 'Sandbox ads VND', currency: 'VND', timeZone: 'Asia/Ho_Chi_Minh' },
    ]);
    expect(await platform.accounts(usd.secret)).toEqual([
      { externalAccountId: usd.externalAccountId, displayName: 'Sandbox ads USD', currency: 'USD', timeZone: 'America/Los_Angeles' },
    ]);
    expect(platform.capabilities).toEqual({ revisionDays: 3, resultKinds: ['purchase', 'lead'] });
  });

  it('reports account and campaign rows whose account row is the sum of its campaigns', async () => {
    const platform = sandboxAdPlatform(at('2026-11-20T08:00:00Z'));
    const { secret, externalAccountId } = platform.connect({ displayName: 'a' });
    const rows = await platform.readDaily(secret, externalAccountId, { from: '2026-10-01', to: '2026-10-31' });
    const accountRows = rows.filter((r) => r.level === 'account');
    expect(accountRows.length).toBeGreaterThan(20);
    for (const row of accountRows) {
      const campaigns = rows.filter((r) => r.level === 'campaign' && r.day === row.day);
      expect(campaigns.length).toBeGreaterThan(0);
      expect(row.spend).toBe(String(campaigns.reduce((n, c) => n + Number(c.spend), 0)));
      expect(row.impressions).toBe(campaigns.reduce((n, c) => n + c.impressions, 0));
      expect(row.clicks).toBe(campaigns.reduce((n, c) => n + c.clicks, 0));
      expect(Number(row.results.purchase)).toBe(campaigns.reduce((n, c) => n + Number(c.results.purchase), 0));
      expect(row.externalObjectId).toBe(externalAccountId);
      // The account's reach is a little less than the campaigns', which overlap.
      expect(row.reach as number).toBeLessThanOrEqual(campaigns.reduce((n, c) => n + (c.reach as number), 0));
    }
    expect(rows.every((r) => r.day >= '2026-10-01' && r.day <= '2026-10-31' && /^\d+$/.test(r.spend))).toBe(true);
  });

  it('gives dollars two decimals', async () => {
    const platform = sandboxAdPlatform(at('2026-11-20T08:00:00Z'));
    const { secret, externalAccountId } = platform.connect({ displayName: 'a', currency: 'USD' });
    const rows = await platform.readDaily(secret, externalAccountId, { from: '2026-10-01', to: '2026-10-10' });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => /^\d+\.\d{2}$/.test(r.spend))).toBe(true);
  });

  it('reports a settled day the same every time, and a day inside the revision window as it drifts', async () => {
    const connected = sandboxAdPlatform(at('2026-11-20T08:00:00Z')).connect({ displayName: 'a' });
    // A token of its own: the platform skips some campaign days by the token's seed, so a drawn token would leave a window
    // without a row now and then. With this one the rows are the same on every run.
    const secret = JSON.stringify({ ...JSON.parse(connected.secret), accessToken: `sbx_${'A'.repeat(43)}` });
    const read = (iso: string, from: string, to: string) => sandboxAdPlatform(at(iso)).readDaily(secret, connected.externalAccountId, { from, to });
    // 2026-11-10 is long final on both reads: the minute of the hour changes nothing.
    expect(await read('2026-11-20T08:01:00Z', '2026-11-10', '2026-11-10')).toEqual(await read('2026-11-20T08:04:00Z', '2026-11-10', '2026-11-10'));
    // 2026-11-17 to 2026-11-19 are inside the three days before today (in Ho Chi Minh City it is the 20th): they move with the minute.
    const first = await read('2026-11-20T08:01:00Z', '2026-11-17', '2026-11-19');
    const second = await read('2026-11-20T08:04:00Z', '2026-11-17', '2026-11-19');
    expect(first.length).toBeGreaterThan(0);
    expect(first).not.toEqual(second);
  });

  it('never reports a day after today in the account time zone', async () => {
    const platform = sandboxAdPlatform(at('2026-11-20T18:00:00Z'));
    const { secret, externalAccountId } = platform.connect({ displayName: 'a' });
    // 18:00 UTC is already the 21st in Ho Chi Minh City.
    const rows = await platform.readDaily(secret, externalAccountId, { from: '2026-11-18', to: '2026-11-30' });
    expect(Math.max(...rows.map((r) => Date.parse(r.day)))).toBeLessThanOrEqual(Date.parse('2026-11-21'));
    expect(rows.some((r) => r.day === '2026-11-22')).toBe(false);
  });

  it('refuses a bad secret, another account, a bad range and a range that is too long', async () => {
    const platform = sandboxAdPlatform(at('2026-11-20T08:00:00Z'));
    const { secret, externalAccountId } = platform.connect({ displayName: 'a' });
    await expect(platform.accounts('nope')).rejects.toThrow('invalid secret');
    await expect(platform.accounts(JSON.stringify({ accessToken: 'sbx_short', currency: 'VND' }))).rejects.toThrow('invalid secret');
    await expect(platform.readDaily(secret, 'sbxads-0000000000000000', { from: '2026-11-01', to: '2026-11-02' })).rejects.toThrow('unknown account');
    await expect(platform.readDaily(secret, externalAccountId, { from: '2026-11-02', to: '2026-11-01' })).rejects.toThrow('invalid range');
    await expect(platform.readDaily(secret, externalAccountId, { from: '2026-11-1', to: '2026-11-02' })).rejects.toThrow('invalid range');
    await expect(platform.readDaily(secret, externalAccountId, { from: '2026-01-01', to: '2026-11-02' })).rejects.toThrow('range too long');
    expect(() => platform.connect({ displayName: 'a', currency: 'EUR' as 'USD' })).toThrow('unknown currency');
  });

  it('names a typed error without the platform message', () => {
    const error = new AdPlatformError('rate_limited', '80000', new Date('2026-11-20T09:00:00Z'));
    expect(error).toMatchObject({ kind: 'rate_limited', code: '80000' });
    expect(error.retryAt?.toISOString()).toBe('2026-11-20T09:00:00.000Z');
    expect(error.message).toBe('ad platform error: rate_limited 80000');
  });
});

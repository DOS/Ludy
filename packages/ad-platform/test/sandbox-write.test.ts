// SPDX-License-Identifier: AGPL-3.0-only
// The offline sandbox of running ads (ADR-0043, #2294, W0b): the write connection's login, its own secret (never the reader's), and
// the verify that reaches no host. It is not an ad platform of the readers' registry.
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { AD_PLATFORM_PROVIDERS, SANDBOX_WRITE_PROVIDER, SANDBOX_WRITE_SCOPES, adPlatforms, isAdPlatformProvider, sandboxAdPlatform, sandboxAdWriter, sandboxWriteLogin } from '../src/index.ts';

const READ_ACCOUNT = 'sbxads-0123456789abcdef';

describe('the sandbox ad writer', () => {
  it('logs in to the account of the read connection, with a secret of its own and the scopes that can run ads', () => {
    const login = sandboxWriteLogin({ externalAccountId: READ_ACCOUNT, currency: 'VND' });
    expect(login).toMatchObject({ provider: 'sandboxwrite_ads', externalAccountId: READ_ACCOUNT, scopes: ['ads_read', 'ads_management'], expiresAt: null });
    expect(SANDBOX_WRITE_PROVIDER).toBe('sandboxwrite_ads');
    expect(SANDBOX_WRITE_SCOPES).toEqual(['ads_read', 'ads_management']);
    expect(login.displayName).toBe('Sandbox ads VND (running ads)');
    const secret = JSON.parse(login.secret) as Record<string, unknown>;
    expect(Object.keys(secret).sort()).toEqual(['accessToken', 'accountId', 'currency']);
    expect(secret.accessToken).toMatch(/^sbxw_[A-Za-z0-9_-]{43}$/);
    expect(secret.accountId).toBe(READ_ACCOUNT);
    expect(secret.currency).toBe('VND');
    // A name of the caller's, and a new token each time.
    const again = sandboxWriteLogin({ externalAccountId: READ_ACCOUNT, currency: 'USD', displayName: 'Chạy quảng cáo thử' });
    expect(again.displayName).toBe('Chạy quảng cáo thử');
    expect(again.secret).not.toBe(login.secret);
  });

  it('refuses an account id or a currency it does not know, before it makes a token', () => {
    expect(() => sandboxWriteLogin({ externalAccountId: 'not an id!', currency: 'VND' })).toThrow('invalid account id');
    expect(() => sandboxWriteLogin({ externalAccountId: '', currency: 'VND' })).toThrow('invalid account id');
    // The currency of a read account is text from the database: any but the sandbox's two is refused.
    expect(() => sandboxWriteLogin({ externalAccountId: READ_ACCOUNT, currency: 'EUR' })).toThrow('unknown currency');
    expect(() => sandboxWriteLogin({ externalAccountId: READ_ACCOUNT, currency: 'vnd' })).toThrow('unknown currency');
  });

  it('says a token it made can run ads on its account, and opens nothing remote', async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error('a host was reached');
    });
    vi.stubGlobal('fetch', fetchSpy);
    try {
      const login = sandboxWriteLogin({ externalAccountId: READ_ACCOUNT, currency: 'USD' });
      expect(sandboxAdWriter.provider).toBe('sandboxwrite_ads');
      expect(await sandboxAdWriter.verify(login.secret, { externalAccountId: READ_ACCOUNT })).toEqual({ canRunAds: true, scopes: ['ads_read', 'ads_management'] });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('refuses the token of the reader, a garbled secret and one with a field missing, as a refused token', async () => {
    const reader = sandboxAdPlatform().connect({ displayName: 'a' });
    const refused = { kind: 'token_expired', code: 'BAD_SECRET' };
    // The reader's secret holds a `sbx_` token and a key, not this writer's token and account.
    await expect(sandboxAdWriter.verify(reader.secret, { externalAccountId: reader.externalAccountId })).rejects.toMatchObject(refused);
    await expect(sandboxAdWriter.verify('nope', { externalAccountId: READ_ACCOUNT })).rejects.toMatchObject(refused);
    const login = sandboxWriteLogin({ externalAccountId: READ_ACCOUNT, currency: 'VND' });
    const parsed = JSON.parse(login.secret) as Record<string, unknown>;
    for (const field of ['accessToken', 'accountId', 'currency']) {
      const rest = { ...parsed };
      delete rest[field];
      await expect(sandboxAdWriter.verify(JSON.stringify(rest), { externalAccountId: READ_ACCOUNT }), field).rejects.toMatchObject(refused);
    }
    // A reader's-looking token, and a token of the wrong length, are not this writer's.
    await expect(sandboxAdWriter.verify(JSON.stringify({ ...parsed, accessToken: `sbx_${'A'.repeat(43)}` }), { externalAccountId: READ_ACCOUNT })).rejects.toMatchObject(refused);
    await expect(sandboxAdWriter.verify(JSON.stringify({ ...parsed, accessToken: 'sbxw_short' }), { externalAccountId: READ_ACCOUNT })).rejects.toMatchObject(refused);
    await expect(sandboxAdWriter.verify(JSON.stringify({ ...parsed, currency: 'EUR' }), { externalAccountId: READ_ACCOUNT })).rejects.toMatchObject(refused);
    // The message names no part of the secret.
    await expect(sandboxAdWriter.verify(login.secret.replace('sbxw_', 'x'), { externalAccountId: READ_ACCOUNT })).rejects.toMatchObject({ message: 'ad platform error: token_expired BAD_SECRET' });
  });

  it('refuses an account the token was not made for, as a missing permission', async () => {
    const login = sandboxWriteLogin({ externalAccountId: READ_ACCOUNT, currency: 'VND' });
    await expect(sandboxAdWriter.verify(login.secret, { externalAccountId: 'sbxads-ffffffffffffffff' })).rejects.toMatchObject({ kind: 'permission', code: 'ACCOUNT_NOT_REACHED' });
  });

  it('works next to the reader: the account id is the read connection\'s, and the reader never opens the writer\'s secret', async () => {
    const reader = sandboxAdPlatform();
    const read = reader.connect({ displayName: 'a', currency: 'USD' });
    const login = sandboxWriteLogin({ externalAccountId: read.externalAccountId, currency: 'USD' });
    expect(login.externalAccountId).toBe(read.externalAccountId);
    expect(await sandboxAdWriter.verify(login.secret, { externalAccountId: read.externalAccountId })).toMatchObject({ canRunAds: true });
    // The reader's own secret is unchanged by any of this, and the writer's is not one it accepts.
    await expect(reader.accounts(login.secret)).rejects.toThrow('invalid secret');
    await expect(reader.readDaily(login.secret, read.externalAccountId, { from: '2026-10-01', to: '2026-10-02' })).rejects.toThrow('invalid secret');
    expect(await reader.accounts(read.secret)).toEqual([{ externalAccountId: read.externalAccountId, displayName: 'Sandbox ads USD', currency: 'USD', timeZone: 'America/Los_Angeles' }]);
  });

  it('is not an ad platform of the readers\' registry', () => {
    expect(AD_PLATFORM_PROVIDERS).toEqual(['sandbox_ads', 'meta_ads', 'google_ads']);
    expect(isAdPlatformProvider('sandboxwrite_ads')).toBe(false);
    expect(Object.keys(adPlatforms({ sandbox: true }))).toEqual(['sandbox_ads']);
  });

  it('reaches no host and writes nothing: its source names no network call', () => {
    const source = readFileSync(new URL('../src/sandbox-write.ts', import.meta.url), 'utf8');
    for (const network of ['fetch', 'http:', 'https:', 'node:net', 'node:http']) expect(source, network).not.toContain(network);
  });
});

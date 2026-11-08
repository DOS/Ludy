// SPDX-License-Identifier: AGPL-3.0-only
// The shell: features follow the org and the token, the stored state is checked, sign-in is PKCE, and the generic page
// capture contract reads nothing without a click.
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { EXTENSION_SCOPE_IDS } from '@crove/kernel-contract';
import { FEATURES, visibleFeatures } from '../src/features.ts';
import { activeAccount, emptyState, readState, withAccount, withAddress, withFeature, withoutAccount } from '../src/state.ts';
import { connectUrl, newPkce, parseConnectResult } from '../src/auth.ts';
import { capturePage, type PageCaptureFeature } from '../src/page-capture.ts';

describe('features by module and permission', () => {
  it('shows meetings only when the org runs the module and the token holds the scope', () => {
    expect(visibleFeatures({ scopes: ['meetings'], features: { meetings: true } }).map((f) => f.id)).toEqual(['meetings']);
    expect(visibleFeatures({ scopes: ['meetings'], features: { meetings: false } })).toEqual([]);
    expect(visibleFeatures({ scopes: [], features: { meetings: true } })).toEqual([]);
    expect(visibleFeatures({ scopes: ['meetings'], features: {} })).toEqual([]);
    expect(visibleFeatures(null)).toEqual([]);
  });

  it('asks for the scopes the kernel knows, one per feature', () => {
    expect(FEATURES.map((f) => f.scope).sort()).toEqual([...EXTENSION_SCOPE_IDS].sort());
  });
});

describe('stored state', () => {
  const account = { orgId: 'o1', orgSlug: 'cong-ty', token: 'crx_t', expiresAt: '2027-01-01T00:00:00Z' };

  it('reads damage as the empty state', () => {
    expect(readState(null)).toEqual(emptyState());
    expect(readState('x')).toEqual(emptyState());
    expect(readState({ accounts: { o1: { orgId: 'other', token: 1 } } }).accounts).toEqual({});
  });

  it('keeps one account per org and picks another when the active one is removed', () => {
    let s = withAccount(emptyState(), account);
    s = withAccount(s, { ...account, orgId: 'o2', orgSlug: 'khac' });
    expect(activeAccount(s)?.orgId).toBe('o2');
    s = withoutAccount(s, 'o2');
    expect(activeAccount(s)?.orgId).toBe('o1');
  });

  it('drops every account when the address changes, but keeps the features turned on', () => {
    const s = withFeature(withAccount(emptyState(), account), 'meetings', true);
    const moved = withAddress(s, 'https://ludy.congty.vn');
    expect(moved.accounts).toEqual({});
    expect(moved.enabled.meetings).toBe(true);
    expect(withAddress(s, s.address)).toBe(s);
  });
});

describe('sign-in', () => {
  it('builds a PKCE S256 challenge and a connect address on the configured origin', async () => {
    const pkce = await newPkce();
    expect(pkce.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pkce.challenge).toBe(createHash('sha256').update(pkce.verifier).digest('base64url'));
    const url = new URL(connectUrl('https://ludy.congty.vn', pkce, 'https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/connect', 'Thiết bị'));
    expect(`${url.origin}${url.pathname}`).toBe('https://ludy.congty.vn/-/extension/connect');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('scope')).toBe('meetings');
  });

  it('takes the code only from this flow\'s own redirect and state', async () => {
    const pkce = { verifier: 'v', challenge: 'c', state: 's1' };
    const redirect = 'https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/connect';
    expect(parseConnectResult(`${redirect}?code=crc_x&org=cong-ty&state=s1`, pkce, redirect)).toEqual({ code: 'crc_x', org: 'cong-ty' });
    expect(parseConnectResult(`${redirect}?code=crc_x&org=cong-ty&state=other`, pkce, redirect)).toEqual({ error: 'invalid' });
    expect(parseConnectResult(`https://evil.example/connect?code=crc_x&org=a&state=s1`, pkce, redirect)).toEqual({ error: 'invalid' });
    expect(parseConnectResult(`${redirect}?error=access_denied&state=s1`, pkce, redirect)).toEqual({ error: 'access_denied' });
  });
});

describe('page capture contract', () => {
  const feature: PageCaptureFeature = { id: 'demo', scope: 'meetings', command: 'x.y.z', toInput: ({ page }) => ({ url: page.url, text: page.selectedText }) };
  const read = () => ({ url: 'https://example.com/a', title: 'T', selectedText: 'chosen' });

  it('reads nothing without a click', () => {
    let reads = 0;
    expect(capturePage(feature, false, () => (reads += 1, read()))).toBeNull();
    expect(reads).toBe(0);
  });

  it('sends the page to exactly the one command the feature names', () => {
    expect(capturePage(feature, true, read)).toEqual({ command: 'x.y.z', input: { url: 'https://example.com/a', text: 'chosen' } });
  });
});

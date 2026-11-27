// SPDX-License-Identifier: AGPL-3.0-only
// The shell: features follow the org and the token, the stored state upgrades cleanly without leaking tokens across
// origins, sign-in is PKCE, and the generic page capture contract reads nothing without a click.
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { EXTENSION_SCOPE_IDS } from '@ludy/kernel-contract';
import { FEATURES, visibleFeatures } from '../src/features.ts';
import { AGENDA_SCOPE } from '../src/agenda.ts';
import { activeAccount, createCaptureDraftStore, emptyState, readState, withAccount, withoutAccount } from '../src/state.ts';
import { FALLBACK_EXTENSION_SCOPES, connectUrl, newPkce, parseConnectResult, resolveSignInScopes } from '../src/auth.ts';
import { capturePage, type PageCaptureFeature } from '../src/page-capture.ts';

describe('features by module and permission', () => {
  it('shows meetings and notes only when the org runs the module and the token holds the scope', () => {
    expect(visibleFeatures({ scopes: ['meetings'], features: { meetings: true } }).map((f) => f.id)).toEqual(['meetings']);
    expect(visibleFeatures({ scopes: ['notes'], features: { notes: true } }).map((f) => f.id)).toEqual(['notes']);
    expect(visibleFeatures({ scopes: ['meetings', 'notes'], features: { meetings: true, notes: true } }).map((f) => f.id)).toEqual(['meetings', 'notes']);
    expect(visibleFeatures({ scopes: ['notes'], features: { notes: false } })).toEqual([]);
    expect(visibleFeatures({ scopes: ['meetings'], features: { meetings: false } })).toEqual([]);
    expect(visibleFeatures({ scopes: [], features: { meetings: true, notes: true } })).toEqual([]);
    expect(visibleFeatures({ scopes: ['meetings', 'notes'], features: {} })).toEqual([]);
    expect(visibleFeatures(null)).toEqual([]);
  });

  it('asks for the scopes the kernel knows: one per feature, and the agenda scope only when the member chooses it (B2)', () => {
    expect([...FEATURES.map((f) => f.scope), AGENDA_SCOPE].sort()).toEqual([...EXTENSION_SCOPE_IDS].sort());
  });
});

describe('stored state', () => {
  const account = { orgId: 'o1', orgSlug: 'cong-ty', token: 'crx_t', expiresAt: '2027-01-01T00:00:00Z' };

  it('reads damage as the empty state', () => {
    expect(readState(null)).toEqual(emptyState());
    expect(readState('x')).toEqual(emptyState());
    expect(readState({ accounts: { o1: { orgId: 'other', token: 1 } } }).accounts).toEqual({});
    expect(readState({ accounts: { o1: account } }).accounts).toEqual({});
  });

  it('keeps one account per org and picks another when the active one is removed', () => {
    let s = withAccount(emptyState(), account);
    s = withAccount(s, { ...account, orgId: 'o2', orgSlug: 'khac' });
    expect(activeAccount(s)?.orgId).toBe('o2');
    s = withoutAccount(s, 'o2');
    expect(activeAccount(s)?.orgId).toBe('o1');
  });

  it('upgrades legacy app.ludy.vn Cloud state cleanly while dropping accounts from foreign origins without leaking tokens', () => {
    const cloudUpgraded = readState({
      address: 'https://app.ludy.vn',
      accounts: { o1: account },
      activeOrg: 'o1',
      enabled: { meetings: true },
    });
    expect(cloudUpgraded).toEqual({
      appAddress: 'https://app.ludy.vn',
      apiAddress: 'https://api.ludy.vn',
      accounts: { o1: account },
      activeOrg: 'o1',
      enabled: { meetings: true },
    });

    const foreignLegacy = readState({
      address: 'https://ludy.congty.vn',
      accounts: { o1: account },
      activeOrg: 'o1',
      enabled: { meetings: true, clipper: true },
    });
    expect(foreignLegacy).toEqual({
      appAddress: 'https://app.ludy.vn',
      apiAddress: 'https://api.ludy.vn',
      accounts: {},
      activeOrg: null,
      enabled: { meetings: true, clipper: true },
    });

    const mismatchedSplit = readState({
      appAddress: 'https://app.other.example',
      apiAddress: 'https://api.other.example',
      accounts: { o1: account },
      activeOrg: 'o1',
      enabled: { notes: true },
    });
    expect(mismatchedSplit.accounts).toEqual({});
    expect(mismatchedSplit.activeOrg).toBeNull();
    expect(mismatchedSplit.enabled).toEqual({ notes: true });
    expect(mismatchedSplit.appAddress).toBe('https://app.ludy.vn');
    expect(mismatchedSplit.apiAddress).toBe('https://api.ludy.vn');
  });
});

describe('sign-in', () => {
  it('builds a PKCE S256 challenge and a connect address on the configured App origin', async () => {
    const pkce = await newPkce();
    expect(pkce.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pkce.challenge).toBe(createHash('sha256').update(pkce.verifier).digest('base64url'));
    const url = new URL(connectUrl('https://app.ludy.vn', pkce, 'https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/connect', 'Thiết bị'));
    expect(`${url.origin}${url.pathname}`).toBe('https://app.ludy.vn/-/extension/connect');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('scope')).toBe('meetings notes');
  });

  it('takes the code only from this flow\'s own redirect and state', async () => {
    const pkce = { verifier: 'v', challenge: 'c', state: 's1' };
    const redirect = 'https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/connect';
    expect(parseConnectResult(`${redirect}?code=crc_x&org=cong-ty&state=s1`, pkce, redirect)).toEqual({ code: 'crc_x', org: 'cong-ty' });
    expect(parseConnectResult(`${redirect}?code=crc_x&org=cong-ty&state=other`, pkce, redirect)).toEqual({ error: 'invalid' });
    expect(parseConnectResult(`https://evil.example/connect?code=crc_x&org=a&state=s1`, pkce, redirect)).toEqual({ error: 'invalid' });
    expect(parseConnectResult(`${redirect}?error=access_denied&state=s1`, pkce, redirect)).toEqual({ error: 'access_denied' });
  });

  it('narrows fallback sign-in scopes to meetings when /api/config omits modules or lacks matching features (#3742)', async () => {
    expect(FALLBACK_EXTENSION_SCOPES).toEqual(['meetings']);
    expect(resolveSignInScopes(undefined)).toEqual(['meetings']);
    expect(resolveSignInScopes(null)).toEqual(['meetings']);
    expect(resolveSignInScopes([])).toEqual(['meetings']);
    expect(resolveSignInScopes(['kernel', 'finance'])).toEqual(['meetings']);
    expect(resolveSignInScopes(['kernel', 'notes'])).toEqual(['notes']);
    expect(resolveSignInScopes(['kernel', 'meetings'])).toEqual(['meetings']);
    expect(resolveSignInScopes(['kernel', 'meetings', 'notes'])).toEqual(['meetings', 'notes']);

    const pkce = await newPkce();
    const redirect = 'https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/connect';
    const emptyFallback = new URL(connectUrl('https://app.ludy.vn', pkce, redirect, 'Thiết bị', false, []));
    expect(emptyFallback.searchParams.get('scope')).toBe('meetings');
  });
});

describe('capture draft scope and concurrency (#3742)', () => {
  it('keys capture drafts by (apiUrl, orgId) and clears drafts and pending ops on sign-out or server change', () => {
    const store = createCaptureDraftStore();
    const apiA = 'https://api-a.example';
    const apiB = 'https://api-b.example';

    store.syncState({
      apiAddress: apiA,
      accounts: {
        org1: { orgId: 'org1', orgSlug: 'one', token: 't1', expiresAt: '2027-01-01T00:00:00Z' },
        org2: { orgId: 'org2', orgSlug: 'two', token: 't2', expiresAt: '2027-01-01T00:00:00Z' },
      },
      activeOrg: 'org1',
    });

    const d1 = store.get(apiA, 'org1');
    d1.draft.title = 'Org 1 secret';
    d1.draft.body = 'Private note';
    d1.draft.sourceUrl = 'https://example.com/1';

    // Switching to org2 isolates the draft immediately.
    const switchToOrg2 = store.syncState({
      apiAddress: apiA,
      accounts: {
        org1: { orgId: 'org1', orgSlug: 'one', token: 't1', expiresAt: '2027-01-01T00:00:00Z' },
        org2: { orgId: 'org2', orgSlug: 'two', token: 't2', expiresAt: '2027-01-01T00:00:00Z' },
      },
      activeOrg: 'org2',
    });
    expect(switchToOrg2.changed).toBe(true);
    expect(store.get(apiA, 'org2').draft.title).toBe('');
    expect(store.get(apiA, 'org2').draft.sourceUrl).toBeNull();

    // Start an in-flight capture op in org2, then switch to org1 (without signing out org2).
    const opOrg2 = store.beginOp(apiA, 'org2');
    expect(opOrg2).not.toBeNull();
    expect(opOrg2!.op.isLive()).toBe(true);
    expect(opOrg2!.op.isActive()).toBe(true);

    store.syncState({
      apiAddress: apiA,
      accounts: {
        org1: { orgId: 'org1', orgSlug: 'one', token: 't1', expiresAt: '2027-01-01T00:00:00Z' },
        org2: { orgId: 'org2', orgSlug: 'two', token: 't2', expiresAt: '2027-01-01T00:00:00Z' },
      },
      activeOrg: 'org1',
    });
    expect(opOrg2!.op.isLive()).toBe(true);
    expect(opOrg2!.op.isActive()).toBe(false);
    opOrg2!.op.end();
    expect(store.get(apiA, 'org2').busy).toBe(false);

    // Start an in-flight op in org1, then sign out org1 and sign right back into org1: old op must be invalidated.
    const opOrg1 = store.beginOp(apiA, 'org1');
    expect(opOrg1).not.toBeNull();
    store.clearScope(apiA, 'org1');
    store.syncState({
      apiAddress: apiA,
      accounts: {
        org1: { orgId: 'org1', orgSlug: 'one', token: 't1b', expiresAt: '2027-01-01T00:00:00Z' },
        org2: { orgId: 'org2', orgSlug: 'two', token: 't2', expiresAt: '2027-01-01T00:00:00Z' },
      },
      activeOrg: 'org1',
    });
    expect(opOrg1!.op.isLive()).toBe(false);
    expect(opOrg1!.op.isActive()).toBe(false);
    expect(store.get(apiA, 'org1').draft.title).toBe('');
    expect(store.get(apiA, 'org1').busy).toBe(false);

    // Calling end() on the stale op must not release a newly started op in the re-signed session.
    const newOpOrg1 = store.beginOp(apiA, 'org1');
    expect(newOpOrg1).not.toBeNull();
    opOrg1!.op.end();
    expect(store.get(apiA, 'org1').busy).toBe(true);
    newOpOrg1!.op.end();

    // Switching API origin clears drafts even if an orgId matches.
    store.get(apiA, 'org1').draft.title = 'Server A only';
    store.syncState({
      apiAddress: apiB,
      accounts: {
        org1: { orgId: 'org1', orgSlug: 'one', token: 'tb', expiresAt: '2027-01-01T00:00:00Z' },
      },
      activeOrg: 'org1',
    });
    expect(store.get(apiB, 'org1').draft.title).toBe('');
    expect(newOpOrg1!.op.isLive()).toBe(false);
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

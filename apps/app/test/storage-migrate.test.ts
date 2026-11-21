// SPDX-License-Identifier: AGPL-3.0-only
// Dual-read and legacy-key cleanup tests for browser storage migration (#3966).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTH_STORAGE_KEY, LEGACY_AUTH_STORAGE_KEY, migrateAuthStorage } from '../src/lib/auth.ts';
import { forgetInvite, pendingInvite } from '../src/lib/invite.ts';
import { keepEntity, keptEntity } from '../src/lib/legal-entity-choice.ts';
import { pendingInteraction, rememberInteraction } from '../src/lib/oauth-consent.ts';
import { rememberOAuthAttempt, takeOAuthAttempt } from '../src/lib/oauth.ts';
import { rememberOrgLeft, takeOrgLeft } from '../src/lib/org-access.ts';
import { pendingDirectSignToken, pendingSignToken, rememberDirectSignToken, rememberSignToken } from '../src/lib/sign-hash.ts';
import { clearDraft, loadDraft } from '../src/lib/social-draft.ts';
import { occasionsShown, setOccasionsShown } from '../src/lib/social-occasions.ts';
import {
  promoteMigratedItem,
  readLegacyAwareItem,
  readMigratedItem,
  removeMigratedItem,
  takeMigratedItem,
  writeMigratedItem,
  type StorageLike,
} from '../src/lib/storage-migrate.ts';

function memoryStorage(initial: Record<string, string> = {}): Storage & { data: Map<string, string> } {
  const data = new Map<string, string>(Object.entries(initial));
  return {
    data,
    get length() {
      return data.size;
    },
    clear: () => void data.clear(),
    key: (i: number) => [...data.keys()][i] ?? null,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, String(v)),
    removeItem: (k: string) => void data.delete(k),
  };
}

describe('storage-migrate helpers', () => {
  it('promotes a legacy value on first read and drops the legacy key', () => {
    const store = memoryStorage({ 'crove-key': 'hello' });
    expect(readMigratedItem(store, 'ludy-key', 'crove-key')).toBe('hello');
    expect(store.getItem('ludy-key')).toBe('hello');
    expect(store.getItem('crove-key')).toBeNull();
  });

  it('prefers the new key when both exist', () => {
    const store = memoryStorage({ 'ludy-key': 'new', 'crove-key': 'old' });
    expect(readMigratedItem(store, 'ludy-key', 'crove-key')).toBe('new');
    expect(store.getItem('ludy-key')).toBe('new');
  });

  it('keeps the legacy key untouched when promoting fails due to quota errors', () => {
    const data = new Map<string, string>([['crove-key', 'saved']]);
    const quotaFull: StorageLike = {
      getItem: (k) => data.get(k) ?? null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: (k) => void data.delete(k),
    };
    expect(readMigratedItem(quotaFull, 'ludy-key', 'crove-key')).toBe('saved');
    expect(data.get('crove-key')).toBe('saved');
  });

  it('supports legacy-aware reads, writes, one-shot takes, and paired removals', () => {
    const store = memoryStorage({ 'crove-temp': 'v1' });
    expect(readLegacyAwareItem(store, 'ludy-temp', 'crove-temp')).toEqual({ value: 'v1', fromLegacy: true });
    promoteMigratedItem(store, 'ludy-temp', 'crove-temp', 'v1');
    expect(readLegacyAwareItem(store, 'ludy-temp', 'crove-temp')).toEqual({ value: 'v1', fromLegacy: false });
    writeMigratedItem(store, 'ludy-temp', 'crove-temp', 'v2');
    expect(store.getItem('ludy-temp')).toBe('v2');
    expect(store.getItem('crove-temp')).toBeNull();
    store.setItem('crove-once', 'payload');
    expect(takeMigratedItem(store, 'ludy-once', 'crove-once')).toBe('payload');
    expect(store.getItem('crove-once')).toBeNull();
    store.setItem('ludy-del', '1');
    store.setItem('crove-del', '1');
    removeMigratedItem(store, 'ludy-del', 'crove-del');
    expect(store.getItem('ludy-del')).toBeNull();
    expect(store.getItem('crove-del')).toBeNull();
  });
});

describe('migrateAuthStorage (#3966)', () => {
  it('migrates crove-auth and PKCE code-verifier keys when ludy-auth keys are absent', () => {
    expect(AUTH_STORAGE_KEY).toBe('ludy-auth');
    expect(LEGACY_AUTH_STORAGE_KEY).toBe('crove-auth');
    const store = memoryStorage({
      'crove-auth': JSON.stringify({ access_token: 'tok' }),
      'crove-auth-code-verifier': 'verifier-123',
      'crove-auth-flows-code-verifier': 'flows-123',
      'crove-auth-flow-abc-code-verifier': 'flow-abc',
    });
    migrateAuthStorage(store);
    expect(store.getItem('ludy-auth')).toBe(JSON.stringify({ access_token: 'tok' }));
    expect(store.getItem('ludy-auth-code-verifier')).toBe('verifier-123');
    expect(store.getItem('ludy-auth-flows-code-verifier')).toBe('flows-123');
    expect(store.getItem('ludy-auth-flow-abc-code-verifier')).toBe('flow-abc');
    expect(store.getItem('crove-auth')).toBeNull();
    expect(store.getItem('crove-auth-code-verifier')).toBeNull();
    expect(store.getItem('crove-auth-flows-code-verifier')).toBeNull();
    expect(store.getItem('crove-auth-flow-abc-code-verifier')).toBeNull();
  });

  it('preserves existing ludy-auth values and removes leftover crove-auth entries', () => {
    const store = memoryStorage({
      'ludy-auth': JSON.stringify({ access_token: 'fresh' }),
      'crove-auth': JSON.stringify({ access_token: 'stale' }),
      'ludy-auth-code-verifier': 'fresh-v',
      'crove-auth-code-verifier': 'stale-v',
    });
    migrateAuthStorage(store);
    expect(store.getItem('ludy-auth')).toBe(JSON.stringify({ access_token: 'fresh' }));
    expect(store.getItem('ludy-auth-code-verifier')).toBe('fresh-v');
    expect(store.getItem('crove-auth')).toBeNull();
    expect(store.getItem('crove-auth-code-verifier')).toBeNull();
  });

  it('does not throw when storage fails in private mode', () => {
    const blocked: StorageLike = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('SecurityError');
      },
      removeItem: () => {
        throw new Error('SecurityError');
      },
    };
    expect(() => migrateAuthStorage(blocked)).not.toThrow();
  });
});

describe('legacy key migration across app stores (#3966)', () => {
  let local: ReturnType<typeof memoryStorage>;
  let session: ReturnType<typeof memoryStorage>;

  beforeEach(() => {
    local = memoryStorage();
    session = memoryStorage();
    vi.stubGlobal('localStorage', local);
    vi.stubGlobal('sessionStorage', session);
    vi.stubGlobal('window', {
      localStorage: local,
      sessionStorage: session,
      location: { pathname: '/', search: '', hash: '' },
      history: { state: null, replaceState: vi.fn() },
      matchMedia: () => ({ matches: false, addEventListener: vi.fn() }),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('migrates pending invites, legal entity choice, social drafts, and social occasions', () => {
    const now = 1_800_000_000_000;
    const token = 'B'.repeat(43);
    local.setItem('crove-pending-invite', JSON.stringify({ token, savedAt: now }));
    expect(pendingInvite(now + 1000)).toBe(token);
    expect(local.getItem('ludy-pending-invite')).not.toBeNull();
    expect(local.getItem('crove-pending-invite')).toBeNull();
    forgetInvite();
    expect(local.getItem('ludy-pending-invite')).toBeNull();

    local.setItem('crove.legalEntity.cong-ty', 'le-1');
    expect(keptEntity('cong-ty')).toBe('le-1');
    expect(local.getItem('ludy.legalEntity.cong-ty')).toBe('le-1');
    expect(local.getItem('crove.legalEntity.cong-ty')).toBeNull();
    keepEntity('cong-ty', 'le-2');
    expect(local.getItem('ludy.legalEntity.cong-ty')).toBe('le-2');

    local.setItem('crove.social.draft:cong-ty:new', JSON.stringify({ savedAt: '2026-10-20T10:00:00Z', revision: 2, data: { body: 'Hi' } }));
    expect(loadDraft('cong-ty', 'new', Date.parse('2026-10-20T11:00:00Z'))).toEqual({
      savedAt: '2026-10-20T10:00:00Z',
      revision: 2,
      data: { body: 'Hi' },
    });
    expect(local.getItem('ludy.social.draft:cong-ty:new')).not.toBeNull();
    expect(local.getItem('crove.social.draft:cong-ty:new')).toBeNull();
    clearDraft('cong-ty', 'new');
    expect(local.getItem('ludy.social.draft:cong-ty:new')).toBeNull();

    local.setItem('crove.social.occasions.cong-ty', 'off');
    expect(occasionsShown('cong-ty')).toBe(false);
    expect(local.getItem('ludy.social.occasions.cong-ty')).toBe('off');
    expect(local.getItem('crove.social.occasions.cong-ty')).toBeNull();
    setOccasionsShown('cong-ty', true);
    expect(occasionsShown('cong-ty')).toBe(true);
  });

  it('migrates sessionStorage entries for eSign tokens, OAuth state, OAuth interaction, and org-left notices', () => {
    const token = 'C'.repeat(43);
    const payload = JSON.stringify({ token, savedAt: Date.now() });
    session.setItem('crove.sign.ceremony.token', payload);
    session.setItem('crove.sign.direct.token', payload);
    expect(pendingSignToken()).toBe(token);
    expect(pendingDirectSignToken()).toBe(token);
    expect(session.getItem('ludy.sign.ceremony.token')).not.toBeNull();
    expect(session.getItem('crove.sign.ceremony.token')).toBeNull();
    expect(session.getItem('ludy.sign.direct.token')).not.toBeNull();
    expect(session.getItem('crove.sign.direct.token')).toBeNull();
    rememberSignToken('D'.repeat(43));
    rememberDirectSignToken('E'.repeat(43));
    expect(pendingSignToken()).toBe('D'.repeat(43));
    expect(pendingDirectSignToken()).toBe('E'.repeat(43));

    session.setItem('crove.oauth.st1', JSON.stringify({ slug: 'acme', at: Date.now() }));
    expect(takeOAuthAttempt('st1')).toBe('acme');
    expect(session.getItem('crove.oauth.st1')).toBeNull();
    rememberOAuthAttempt('st2', 'beta');
    expect(session.getItem('ludy.oauth.st2')).not.toBeNull();
    expect(takeOAuthAttempt('st2')).toBe('beta');

    const uid = 'AbCdEfGhIjKlMnOpQr';
    session.setItem('crove-pending-oauth-interaction', JSON.stringify({ uid, savedAt: Date.now() }));
    expect(pendingInteraction()).toBe(uid);
    expect(session.getItem('ludy-pending-oauth-interaction')).not.toBeNull();
    expect(session.getItem('crove-pending-oauth-interaction')).toBeNull();
    rememberInteraction(uid);
    expect(pendingInteraction()).toBe(uid);

    session.setItem('crove-org-left', JSON.stringify({ name: 'Acme' }));
    expect(takeOrgLeft(session)).toEqual({ name: 'Acme' });
    expect(session.getItem('crove-org-left')).toBeNull();
    rememberOrgLeft(session, { name: 'Beta' });
    expect(session.getItem('ludy-org-left')).toBe(JSON.stringify({ name: 'Beta' }));
    expect(takeOrgLeft(session)).toEqual({ name: 'Beta' });
  });

  it('migrates crove-theme to ludy-theme in theme-runtime', async () => {
    local.setItem('crove-theme', 'dark');
    vi.stubGlobal('document', {
      documentElement: {
        classList: { toggle: vi.fn() },
        style: { colorScheme: '' },
      },
    });
    vi.resetModules();
    const themeRuntime = await import('../src/lib/theme-runtime.ts');
    expect(themeRuntime.activeThemeSetting()).toBe('dark');
    expect(local.getItem('ludy-theme')).toBe('dark');
    expect(local.getItem('crove-theme')).toBeNull();
  });
});

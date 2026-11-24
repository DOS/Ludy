// SPDX-License-Identifier: AGPL-3.0-only
// Regression tests for per-tab workspace auth isolation on in-person ceremony tabs (#4278, #4394).
import { afterEach, describe, expect, it, vi } from 'vitest';

function createMemoryStorage(initial: Record<string, string> = {}) {
  const data = new Map<string, string>(Object.entries(initial));
  return {
    data,
    get length() {
      return data.size;
    },
    key(index: number) {
      return Array.from(data.keys())[index] ?? null;
    },
    getItem(key: string) {
      return data.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      data.set(key, value);
    },
    removeItem(key: string) {
      data.delete(key);
    },
    clear() {
      data.clear();
    },
  };
}

function setupBrowser(href: string, initialLocal: Record<string, string> = {}, initialSession: Record<string, string> = {}) {
  const url = new URL(href);
  const localStorage = createMemoryStorage(initialLocal);
  const sessionStorage = createMemoryStorage(initialSession);
  const location = {
    get href() {
      return url.href;
    },
    get pathname() {
      return url.pathname;
    },
    get search() {
      return url.search;
    },
    get hash() {
      return url.hash;
    },
    get origin() {
      return url.origin;
    },
  };
  const history = {
    state: null,
    replaceState: (_s: unknown, _t: string, to: string) => {
      const next = new URL(to, url);
      url.pathname = next.pathname;
      url.search = next.search;
      url.hash = next.hash;
    },
  };
  vi.stubGlobal('window', { location, history, localStorage, sessionStorage });
  vi.stubGlobal('document', {});
  vi.stubGlobal('localStorage', localStorage);
  vi.stubGlobal('sessionStorage', sessionStorage);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const target = String(input);
      if (target.endsWith('/api/config')) {
        return new Response(
          JSON.stringify({
            authUrl: 'https://auth.example.test/auth/v1',
            authAnonKey: 'anon-key',
            aiEnabled: false,
            inboundEnabled: false,
            mailEnabled: false,
            modules: ['kernel', 'sign'],
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch in isolation test: ${target}`);
    }),
  );
  return { url, localStorage, sessionStorage };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

const SAMPLE_SESSION = JSON.stringify({
  access_token: 'workspace-host-secret-jwt',
  refresh_token: 'workspace-refresh-token',
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  token_type: 'bearer',
  user: { id: '01900000-0000-7000-8000-000000000011', email: 'staff@example.com' },
});

describe('In-person ceremony per-tab workspace auth isolation (#4278, #4394)', () => {
  it('marks sessionStorage from /-/sign?in_person=1 and isolates auth() from host localStorage without breaking normal tabs', async () => {
    const { url, localStorage, sessionStorage } = setupBrowser('https://app.ludy.vn/-/sign?in_person=1#token123', {
      'ludy-auth': SAMPLE_SESSION,
      'crove-auth-code-verifier': 'legacy-pkce-verifier',
    });

    const signHash = await import('../src/lib/sign-hash.ts');
    const authMod = await import('../src/lib/auth.ts');
    await authMod.loadConfig();

    expect(signHash.isInPersonCeremonyIsolated()).toBe(true);
    expect(sessionStorage.getItem(signHash.SIGN_IN_PERSON_ISOLATED_SESSION_KEY)).toBe('1');

    // Navigating away in the same tab keeps isolation sticky in sessionStorage.
    url.pathname = '/o/acme/overview';
    url.search = '';
    expect(signHash.isInPersonCeremonyIsolated()).toBe(true);

    // Host workspace session and legacy keys in localStorage are never read or deleted.
    await authMod.settleCallback();
    authMod.migrateAuthStorage();
    expect(await authMod.accessToken()).toBeNull();
    expect(await authMod.needsSecondFactor()).toBe(false);
    expect((await authMod.auth().getSession()).data.session).toBeNull();
    expect(localStorage.getItem('ludy-auth')).toBe(SAMPLE_SESSION);
    expect(localStorage.getItem('crove-auth-code-verifier')).toBe('legacy-pkce-verifier');

    // A separate normal workspace tab (fresh sessionStorage) still reads localStorage as before.
    vi.resetModules();
    const normalEnv = setupBrowser('https://app.ludy.vn/o/acme/overview', {
      'ludy-auth': SAMPLE_SESSION,
    });
    const normalHash = await import('../src/lib/sign-hash.ts');
    const normalAuth = await import('../src/lib/auth.ts');
    await normalAuth.loadConfig();
    expect(normalHash.isInPersonCeremonyIsolated()).toBe(false);
    expect(await normalAuth.accessToken()).toBe('workspace-host-secret-jwt');
    expect(normalEnv.sessionStorage.getItem(normalHash.SIGN_IN_PERSON_ISOLATED_SESSION_KEY)).toBeNull();
  });

  it('switches to an isolated client if markInPersonCeremonyIsolated() runs dynamically after load', async () => {
    const { localStorage, sessionStorage } = setupBrowser('https://app.ludy.vn/-/sign#tokenWithoutQueryFlag', {
      'ludy-auth': SAMPLE_SESSION,
    });

    const signHash = await import('../src/lib/sign-hash.ts');
    const authMod = await import('../src/lib/auth.ts');
    await authMod.loadConfig();

    const initialClient = authMod.auth();
    const disposeSpy = vi.spyOn(initialClient, 'dispose');
    expect(await authMod.accessToken()).toBe('workspace-host-secret-jwt');

    // API responds with view.inPerson = true -> ceremony marks this tab isolated and disposes the prior client immediately.
    signHash.markInPersonCeremonyIsolated();
    expect(disposeSpy).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem(signHash.SIGN_IN_PERSON_ISOLATED_SESSION_KEY)).toBe('1');
    expect(await authMod.accessToken()).toBeNull();
    const isolatedClient = authMod.auth();
    expect(isolatedClient).not.toBe(initialClient);
    expect((await isolatedClient.getSession()).data.session).toBeNull();
    // Signing out in the isolated tab never removes the host's localStorage session.
    await isolatedClient.signOut({ scope: 'local' });
    expect(localStorage.getItem('ludy-auth')).toBe(SAMPLE_SESSION);
  });

  it('does not isolate unrelated direct links unless explicitly marked', async () => {
    setupBrowser('https://app.ludy.vn/-/sign/d?in_person=1');
    const signHash = await import('../src/lib/sign-hash.ts');
    expect(signHash.isSignCeremonyPathname('/-/sign/d')).toBe(false);
    expect(signHash.isInPersonCeremonyIsolated()).toBe(false);
  });
});

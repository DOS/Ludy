// SPDX-License-Identifier: AGPL-3.0-only
// With the identity provider's OAuth App as the only way in (AUTH_SIGN_IN=oauth, issue #4704) the password is the provider's:
// /reset-password goes back to the app, for a signed-in person too, and a recovery event no longer sends anyone there. With the
// setting off the route is as before (it asks for a session).
import { createMemoryHistory, createRouter } from '@tanstack/react-router';
import { beforeAll, describe, expect, it, vi } from 'vitest';

const config = vi.hoisted(() => ({ signIn: 'form' as 'form' | 'oauth', token: 'token' as string | null }));
vi.mock('../src/lib/auth.ts', async (original) => ({
  ...(await original<typeof import('../src/lib/auth.ts')>()),
  accessToken: async () => config.token,
  needsSecondFactor: async () => false,
  getConfig: () => ({ modules: ['kernel'], signIn: config.signIn }),
  // The original reads its own getConfig; the router must see the mocked one.
  passwordResetBlocked: () => config.signIn === 'oauth',
}));

type Router = (typeof import('../src/router.tsx'))['router'];
let router: Router;
beforeAll(async () => {
  const store = new Map<string, string>();
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
  vi.stubGlobal('window', { location: { origin: 'http://localhost', hash: '', pathname: '/', search: '' }, addEventListener() {}, removeEventListener() {}, localStorage: storage, sessionStorage: storage });
  vi.stubGlobal('localStorage', storage);
  vi.stubGlobal('sessionStorage', storage);
  ({ router } = await import('../src/router.tsx'));
}, 30_000);

const lands = async (address: string) => {
  const r = createRouter({ routeTree: router.routeTree, history: createMemoryHistory({ initialEntries: [address] }), isServer: false });
  await r.load();
  return r.state.location.pathname;
};

describe('/reset-password with the OAuth App as the only way in', () => {
  it('goes back to the app for a signed-in person, and for nobody signed in', async () => {
    config.signIn = 'oauth';
    config.token = 'token';
    expect(await lands('/reset-password')).not.toBe('/reset-password');
    config.token = null;
    expect(await lands('/reset-password')).not.toBe('/reset-password');
  });

  it('is unchanged with the form: a signed-in person reaches it, nobody else does', async () => {
    config.signIn = 'form';
    config.token = 'token';
    expect(await lands('/reset-password')).toBe('/reset-password');
    config.token = null;
    expect(await lands('/reset-password')).not.toBe('/reset-password');
  });
});

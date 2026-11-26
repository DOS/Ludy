// SPDX-License-Identifier: AGPL-3.0-only
// The app's wiring: the real ports (expo modules) into the session manager and the step-up gate, and the one QueryClient. Nothing
// here has logic worth testing on its own; the logic is in auth/ and is tested with fake ports.
import { QueryCache, QueryClient } from '@tanstack/react-query';
import { createLudyClient, isMfaRequired, isOrgAccessRevoked, isUnauthenticated, requestHeaders, type LudyClient } from '@ludy/client';
import { createSessionManager } from './auth/session.ts';
import { createStepUpGate } from './auth/step-up.ts';
import { createVault } from './auth/vault.ts';
import { serverAllowed, serverPolicy } from './config.ts';
import { revokeCurrentSession } from './auth/revoke.ts';
import { createTranslator, deviceLocale } from './i18n.ts';
import { systemBrowser } from './platform/browser.ts';
import { deviceCrypto } from './platform/crypto.ts';
import { deviceLocalAuth } from './platform/local-auth.ts';
import { secureKeyValue } from './platform/secure-store.ts';
import { createApprovalsCache, type ApprovalsCache } from './screens/approvals/cache.ts';

export const locale = deviceLocale();
export const t = createTranslator(locale);
export const approvalsCache: ApprovalsCache = createApprovalsCache(secureKeyValue);

// Inlined by Expo at build time; public settings, never secrets (config.ts serverPolicy).
export const SERVER_POLICY = serverPolicy(process.env['EXPO_PUBLIC_LUDY_URL'], process.env['EXPO_PUBLIC_LUDY_CUSTOM_SERVER']);

export const session = createSessionManager({
  vault: createVault(secureKeyValue),
  crypto: deviceCrypto,
  browser: systemBrowser,
  localAuth: deviceLocalAuth,
  fetchFn: (input, init) => fetch(input, init),
  now: () => Date.now(),
  unlockPrompt: t('lock.prompt'),
  serverAllowed: (serverUrl) => serverAllowed(SERVER_POLICY, serverUrl),
  // Ends the session on the server before the phone forgets it (auth/revoke.ts).
  revokeOnServer: async (accessToken) => {
    const state = session.state();
    if (state.status === 'active') await revokeCurrentSession(state.serverUrl, accessToken);
  },
});

export const stepUp = createStepUpGate({ localAuth: deviceLocalAuth, now: () => Date.now() });

// A request refused because the session is over signs the phone out; the other refusals are the screen's to show.
export const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: (error) => void session.reportKernelError(error) }),
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      retry: (count, error) => !isUnauthenticated(error) && !isMfaRequired(error) && !isOrgAccessRevoked(error) && count < 1,
    },
  },
});

// The kernel's client for the session this phone holds. The address is the one stored with the session and the token is asked
// for on every request, so a refreshed token is used at once and no token is kept here.
export function clientFor(serverUrl: string): LudyClient {
  return createLudyClient({
    origin: serverUrl,
    headers: async () => {
      const state = session.state();
      const token = await session.accessToken();
      // No token (a refresh that did not work, a lock): the request is not sent. Sent without one, the kernel would answer 401 and
      // the phone would sign out a session that is still good.
      if (!token) throw new Error('no session token');
      return requestHeaders(token, state.status === 'active' ? state.orgSlug : null);
    },
  });
}

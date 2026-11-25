// SPDX-License-Identifier: AGPL-3.0-only
// The app's wiring: the real ports (expo modules) into the session manager and the step-up gate, and the one QueryClient. Nothing
// here has logic worth testing on its own; the logic is in auth/ and is tested with fake ports.
import { QueryCache, QueryClient } from '@tanstack/react-query';
import { createLudyClient, isMfaRequired, isOrgAccessRevoked, isUnauthenticated, requestHeaders, type LudyClient } from '@ludy/client';
import { createSessionManager } from './auth/session.ts';
import { createStepUpGate } from './auth/step-up.ts';
import { createVault } from './auth/vault.ts';
import { cloudServerUrl } from './config.ts';
import { createTranslator, deviceLocale } from './i18n.ts';
import { systemBrowser } from './platform/browser.ts';
import { deviceCrypto } from './platform/crypto.ts';
import { deviceLocalAuth } from './platform/local-auth.ts';
import { secureKeyValue } from './platform/secure-store.ts';

export const t = createTranslator(deviceLocale());

// Inlined by Expo at build time; a public address, never a secret. Null for a build that asks for the server address.
export const CLOUD_SERVER_URL = cloudServerUrl(process.env['EXPO_PUBLIC_LUDY_URL']);

export const session = createSessionManager({
  vault: createVault(secureKeyValue),
  crypto: deviceCrypto,
  browser: systemBrowser,
  localAuth: deviceLocalAuth,
  fetchFn: (input, init) => fetch(input, init),
  now: () => Date.now(),
  unlockPrompt: t('lock.prompt'),
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
      return requestHeaders(await session.accessToken(), state.status === 'active' ? state.orgSlug : null);
    },
  });
}

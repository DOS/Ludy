// SPDX-License-Identifier: AGPL-3.0-only
// Boot and session-guard helpers ensuring /-/sign ceremony tabs never eagerly instantiate
// a workspace AuthClient before publicSignApi.view(token) determines in-person status.
import { queryClient } from './api.ts';
import { accessToken, auth, getConfig, settleCallback } from './auth.ts';
import { clearRecentItems } from './palette-recents.ts';
import { forgetPushDevice } from './push.ts';
import { stopAndSave } from './recording-controller.ts';
import { isInPersonCeremonyIsolated, isSignCeremonyPathname } from './sign-hash.ts';
import { forgetShare } from './social-share.ts';

let signedOutListenerAttached = false;
let signedOutNavigate: (() => unknown) | null = null;

export function ensureSignedOutListener(
  deps: {
    navigateToLogin?: () => unknown;
    subscribeAuthState?: (cb: (event: string) => void) => unknown;
    isIsolated?: () => boolean;
    onSignedOutCleanup?: () => void;
  } = {},
): boolean {
  if (deps.navigateToLogin) {
    signedOutNavigate = deps.navigateToLogin;
  }
  if (signedOutListenerAttached) return false;
  if (!deps.subscribeAuthState && !getConfig().authUrl) return false;
  signedOutListenerAttached = true;

  const subscribe = deps.subscribeAuthState ?? ((cb) => auth().onAuthStateChange(cb));
  const isIsolated = deps.isIsolated ?? isInPersonCeremonyIsolated;
  const cleanup =
    deps.onSignedOutCleanup ??
    (() => {
      // Signed out here, in another tab or by expiry: a share waiting in this tab is not the next person's.
      forgetShare();
      clearRecentItems();
      // Nor are this browser's push notices (#1238); the session is gone, so only the browser's subscription ends.
      void forgetPushDevice();
      // The session is gone: a recording still running here ends and keeps its copy on the device (the upload cannot go out), so the microphone stops (#3197).
      void stopAndSave({ quiet: true });
      queryClient.clear();
    });

  subscribe((event: string) => {
    if (event === 'SIGNED_OUT' && !isIsolated()) {
      cleanup();
      if (signedOutNavigate) {
        void signedOutNavigate();
      }
    }
  });
  return true;
}

export async function bootWorkspaceAuthSession(
  deps: {
    pathname?: string;
    runSettleCallback?: () => Promise<void>;
    prepareNavigation?: () => Promise<(() => unknown) | void>;
    attachListener?: (navigateToLogin?: () => unknown) => unknown;
  } = {},
): Promise<boolean> {
  const pathname = deps.pathname ?? (typeof window !== 'undefined' ? window.location.pathname : '');
  if (isSignCeremonyPathname(pathname)) {
    return false;
  }
  await (deps.runSettleCallback ?? settleCallback)();
  const navigateToLogin = deps.prepareNavigation ? await deps.prepareNavigation() : undefined;
  const attach = deps.attachListener ?? ((nav) => ensureSignedOutListener(nav ? { navigateToLogin: nav } : {}));
  attach(navigateToLogin ?? undefined);
  return true;
}

export async function enforceSessionGuard(
  deps: {
    isIsolated?: () => boolean;
    getAccessToken?: () => Promise<string | null>;
    onAuthenticated?: () => unknown;
    onRedirectToLogin: () => never;
  },
): Promise<void> {
  const isIsolated = deps.isIsolated ?? isInPersonCeremonyIsolated;
  const getToken = deps.getAccessToken ?? accessToken;

  if (isIsolated() || !(await getToken()) || isIsolated()) {
    deps.onRedirectToLogin();
  }
  (deps.onAuthenticated ?? ensureSignedOutListener)();
}

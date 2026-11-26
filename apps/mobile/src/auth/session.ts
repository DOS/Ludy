// SPDX-License-Identifier: AGPL-3.0-only
// The phone's session (issue #4880): signed out, locked behind the phone's biometrics, or active. Pure logic over ports (the
// secure storage, the system browser, the biometric prompt, fetch, the clock), so every rule below is unit tested without a phone.
//
// The rules:
// - The access token lives in memory only. The refresh token is in the secure storage (vault.ts) and in memory; it is read out
//   of storage at start and used only after the biometric unlock or a sign-in.
// - Refresh tokens rotate: each refresh answers a new one and kills the old one. The new one is written to the secure storage
//   before the new access token is handed to anyone, one refresh runs at a time (two at once would spend the same token twice
//   and end the session), and a refresh that finishes after a sign-out never writes anything back.
// - A refresh the provider rejects (invalid_grant) ends the session; any other failure (no network, a 5xx) keeps it.
// - A 401, or the org revoking this session, from the kernel ends the session: the phone is one org, one member. Revoking the
//   device on the server therefore signs the phone out at its next request or its next refresh, and the home screen asks every
//   few minutes.
// - Sign-out forgets the tokens in memory first, then clears the secure storage. Storage writes run one after another, so a save
//   can never land after the clear that was meant to follow it.
import { isOrgAccessRevoked, isUnauthenticated } from '@ludy/client';
import { REDIRECT_URI, normalizeServerUrl } from '../config.ts';
import { completeSignIn, endpointsFromConfig, refreshTokens, startSignIn, type OauthEndpoints, type SignInFailure, type Tokens } from './oauth.ts';
import type { CryptoPort } from './pkce.ts';
import type { StoredSession, Vault } from './vault.ts';

export interface LocalAuthPort {
  // How well the phone itself is locked: `none` (no screen lock at all), `passcode` (a PIN, pattern or password) or `biometric`.
  level(): Promise<'none' | 'passcode' | 'biometric'>;
  // Asks the person to prove they are the phone's owner (biometric, falling back to the phone's passcode); true when they did.
  authenticate(prompt: string): Promise<boolean>;
}

export interface BrowserPort {
  // Opens the system browser (not a webview of this app) at `url` and resolves with the address it was sent back to.
  open(url: string, redirectUri: string): Promise<{ type: 'success'; url: string } | { type: 'cancel' }>;
}

export type SignOutNotice = 'revoked' | 'expired';

export type SessionState =
  | { status: 'loading' }
  | { status: 'signed-out'; notice: SignOutNotice | null }
  | { status: 'locked'; serverUrl: string }
  | { status: 'active'; serverUrl: string; orgSlug: string | null };

export type SignInResult = { ok: true } | { ok: false; reason: SignInFailure | 'unsupported-server' | 'server-unreachable' | 'no-device-lock' | 'cancelled' | 'storage' | 'busy' };
export type UnlockResult = { ok: true } | { ok: false; reason: 'cancelled' | 'offline' | 'signed-out' | 'busy' };

export interface SessionDeps {
  vault: Vault;
  crypto: CryptoPort;
  browser: BrowserPort;
  localAuth: LocalAuthPort;
  fetchFn: typeof fetch;
  now: () => number;
  // The words of the system's biometric prompt.
  unlockPrompt: string;
  // Whether this build may sign in to this server address (config.ts serverAllowed).
  serverAllowed: (serverUrl: string) => boolean;
  // Best effort, on a person's own sign-out of an unlocked app only: ends the session on the server before the phone forgets it.
  // Given the access token; its failure never stops the sign-out, and it is given 3 seconds. A sign-out from the lock screen
  // does not revoke on the server (there is no access token then): that gap is named in the PR.
  revokeOnServer?: (accessToken: string) => Promise<void>;
}

export interface SessionManager {
  state(): SessionState;
  subscribe(listener: () => void): () => void;
  start(): Promise<void>;
  signIn(serverUrl: string): Promise<SignInResult>;
  unlock(): Promise<UnlockResult>;
  lock(): void;
  // The bearer token for the next request, refreshed first when it is about to end; null when there is no active session.
  accessToken(): Promise<string | null>;
  setOrg(slug: string): Promise<void>;
  // Hands the manager an error a request ended with; true (and the phone signs out) when it says the session is over.
  reportKernelError(error: unknown): boolean;
  signOut(notice?: SignOutNotice): Promise<void>;
}

// A token is refreshed this long before it ends.
export const REFRESH_MARGIN_MS = 60_000;

export function createSessionManager(deps: SessionDeps): SessionManager {
  let state: SessionState = { status: 'loading' };
  const listeners = new Set<() => void>();
  // The session being held: its storage record (with the current refresh token) and the access token made from it.
  let held: StoredSession | null = null;
  let access: Tokens | null = null;
  // Bumped by every sign-out and sign-in: a refresh that started under an older value is of a session that is gone.
  let epoch = 0;
  let refreshing: Promise<'ok' | 'rejected' | 'unavailable' | 'stale'> | null = null;
  let signingIn = false;
  let unlocking: Promise<UnlockResult> | null = null;
  // Storage writes, one after another.
  let writes: Promise<unknown> = Promise.resolve();

  // The state as it is now: after an await, what a narrowing made before it says nothing.
  const current = (): SessionState => state;
  const set = (next: SessionState) => {
    state = next;
    for (const listener of listeners) listener();
  };
  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const run = writes.then(operation, operation);
    writes = run.catch(() => undefined);
    return run;
  };

  async function refreshNow(): Promise<'ok' | 'rejected' | 'unavailable' | 'stale'> {
    if (refreshing) return refreshing;
    const session = held;
    if (!session) return 'stale';
    const startedIn = epoch;
    const promise: Promise<'ok' | 'rejected' | 'unavailable' | 'stale'> = (async () => {
      const result = await refreshTokens(session.endpoints, session.refreshToken, { fetchFn: deps.fetchFn, now: deps.now });
      // Signed out (or in again) while the provider answered: that session is gone, and so is anything this answer carries.
      if (epoch !== startedIn) return 'stale' as const;
      if (!result.ok) {
        if (result.reason === 'rejected') await signOut('expired');
        return result.reason;
      }
      // Rotation: the new refresh token replaces the old one in memory and in the secure storage before the new access token
      // is handed out. The write is queued in this same turn, so a sign-out after this point clears after it.
      held = { ...session, refreshToken: result.tokens.refreshToken };
      const saved = held;
      const written = enqueue(() => deps.vault.save(saved)).catch(() => undefined);
      if (state.status === 'active') access = result.tokens;
      await written;
      return 'ok' as const;
    })().finally(() => {
      // Not a refresh a later sign-in has started in the meantime.
      if (refreshing === promise) refreshing = null;
    });
    refreshing = promise;
    return promise;
  }

  async function signOut(notice?: SignOutNotice): Promise<void> {
    // The person's own sign-out ends the session on the server first, while the token is still in hand.
    if (!notice && deps.revokeOnServer && access && state.status === 'active') {
      const revoke = deps.revokeOnServer(access.accessToken).catch(() => undefined);
      await Promise.race([revoke, new Promise<void>((resolve) => setTimeout(resolve, 3000))]);
    }
    epoch += 1;
    held = null;
    access = null;
    refreshing = null;
    set({ status: 'signed-out', notice: notice ?? null });
    await enqueue(() => deps.vault.clear()).catch(() => undefined);
  }

  async function runUnlock(): Promise<UnlockResult> {
    if (state.status !== 'locked' || !held) return { ok: false, reason: 'signed-out' };
    const ok = await deps.localAuth.authenticate(deps.unlockPrompt).catch(() => false);
    if (!ok) return { ok: false, reason: 'cancelled' };
    // Locked (still) when the prompt answered: a sign-out while it was open wins.
    const now = current();
    if (now.status !== 'locked' || !held) return { ok: false, reason: 'signed-out' };
    const serverUrl = now.serverUrl;
    // Active before the refresh so that the new access token is kept; a failed refresh puts the phone back to locked.
    set({ status: 'active', serverUrl, orgSlug: held.orgSlug });
    const result = await refreshNow();
    if (result === 'ok') return { ok: true };
    if (result === 'rejected' || result === 'stale') return { ok: false, reason: 'signed-out' };
    if (current().status === 'active') {
      access = null;
      set({ status: 'locked', serverUrl });
    }
    return { ok: false, reason: 'offline' };
  }

  async function discover(serverUrl: string): Promise<OauthEndpoints | 'unreachable' | null> {
    try {
      const response = await deps.fetchFn(`${serverUrl}/api/config`, { method: 'GET', headers: { accept: 'application/json' }, credentials: 'omit', cache: 'no-store', redirect: 'error' });
      if (!response.ok) return null;
      return endpointsFromConfig(await response.json());
    } catch {
      return 'unreachable';
    }
  }

  return {
    state: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },

    async start() {
      if (state.status !== 'loading') return;
      const stored = await deps.vault.load();
      if (state.status !== 'loading') return;
      if (stored) {
        held = stored;
        set({ status: 'locked', serverUrl: stored.serverUrl });
      } else {
        set({ status: 'signed-out', notice: null });
      }
    },

    async signIn(rawServerUrl) {
      if (signingIn || state.status !== 'signed-out') return { ok: false, reason: 'busy' };
      signingIn = true;
      try {
        const serverUrl = normalizeServerUrl(rawServerUrl);
        if (!serverUrl || !deps.serverAllowed(serverUrl)) return { ok: false, reason: 'unsupported-server' };
        // A token in the Keychain of a phone with no screen lock is a token anyone holding the phone can use: refused.
        if ((await deps.localAuth.level().catch(() => 'none' as const)) === 'none') return { ok: false, reason: 'no-device-lock' };
        const endpoints = await discover(serverUrl);
        if (endpoints === 'unreachable') return { ok: false, reason: 'server-unreachable' };
        if (!endpoints) return { ok: false, reason: 'unsupported-server' };
        const started = await startSignIn(endpoints, { crypto: deps.crypto, now: deps.now });
        const outcome = await deps.browser.open(started.url, REDIRECT_URI).catch(() => ({ type: 'cancel' as const }));
        if (outcome.type !== 'success') return { ok: false, reason: 'cancelled' };
        // The pending sign-in (state and verifier) is a local of this call: nothing else can reach it, and it is used once.
        const done = await completeSignIn(outcome.url, started.pending, endpoints, { fetchFn: deps.fetchFn, now: deps.now });
        if (!done.ok) return { ok: false, reason: done.reason };
        const session: StoredSession = { serverUrl, endpoints, refreshToken: done.tokens.refreshToken, orgSlug: null };
        try {
          await enqueue(() => deps.vault.save(session));
        } catch {
          // Nothing is kept in memory either: a session that cannot be stored would end with the app and look like a bug.
          return { ok: false, reason: 'storage' };
        }
        epoch += 1;
        held = session;
        access = done.tokens;
        set({ status: 'active', serverUrl, orgSlug: null });
        return { ok: true };
      } finally {
        signingIn = false;
      }
    },

    unlock() {
      if (unlocking) return Promise.resolve({ ok: false, reason: 'busy' } as const);
      unlocking = runUnlock().finally(() => {
        unlocking = null;
      });
      return unlocking;
    },

    // Forgets the access token and asks for the biometric again. The refresh token stays: it is useless without the unlock.
    lock() {
      if (state.status !== 'active') return;
      access = null;
      set({ status: 'locked', serverUrl: state.serverUrl });
    },

    async accessToken() {
      if (state.status !== 'active') return null;
      if (!access || access.expiresAt - deps.now() < REFRESH_MARGIN_MS) {
        const result = await refreshNow();
        if (result !== 'ok') return null;
      }
      return state.status === 'active' ? (access?.accessToken ?? null) : null;
    },

    async setOrg(slug) {
      if (!held || state.status !== 'active') return;
      held = { ...held, orgSlug: slug };
      const saved = held;
      set({ status: 'active', serverUrl: state.serverUrl, orgSlug: slug });
      await enqueue(() => deps.vault.save(saved)).catch(() => undefined);
    },

    reportKernelError(error) {
      if (!isUnauthenticated(error) && !isOrgAccessRevoked(error)) return false;
      if (state.status === 'active') void signOut('revoked');
      return true;
    },

    signOut,
  };
}

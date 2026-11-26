// SPDX-License-Identifier: AGPL-3.0-only
// The one place the phone keeps the session (issue #4880): the platform's secure storage (the iOS Keychain, the Android Keystore,
// through expo-secure-store), behind KeyValue. Never AsyncStorage, a file, a log or a URL. What is kept is the least that a cold
// start needs: the refresh token, the deployment it belongs to (the address and the OAuth endpoints it was issued by, so a
// refresh can only go back to that one provider) and the org the person chose. The access token is never written: it lives in
// memory and is made again from the refresh token at each start, after the biometric.
import type { OauthEndpoints } from './oauth.ts';

export interface KeyValue {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface StoredSession {
  serverUrl: string;
  endpoints: OauthEndpoints;
  refreshToken: string;
  // The slug of the org the phone works in (one org, one member), or null before the person has chosen.
  orgSlug: string | null;
}

export const SESSION_KEY = 'ludy.session.v1';
// Every key the app ever writes, so sign-out can remove all of them.
export const ALL_KEYS = [SESSION_KEY] as const;

export interface Vault {
  load(): Promise<StoredSession | null>;
  save(session: StoredSession): Promise<void>;
  clear(): Promise<void>;
}

function isStoredSession(value: unknown): value is StoredSession & { v: 1 } {
  const s = value as Partial<StoredSession> & { v?: unknown; endpoints?: Partial<OauthEndpoints> | null };
  return (
    typeof value === 'object' &&
    value !== null &&
    s.v === 1 &&
    typeof s.serverUrl === 'string' &&
    typeof s.refreshToken === 'string' &&
    s.refreshToken !== '' &&
    (s.orgSlug === null || typeof s.orgSlug === 'string') &&
    typeof s.endpoints === 'object' &&
    s.endpoints !== null &&
    typeof s.endpoints.clientId === 'string' &&
    typeof s.endpoints.authorizeUrl === 'string' &&
    typeof s.endpoints.tokenUrl === 'string'
  );
}

export function createVault(kv: KeyValue): Vault {
  return {
    // A blob that is not a session of this version is deleted and read as no session: fail closed, never a half-trusted one.
    async load() {
      let raw: string | null;
      try {
        raw = await kv.get(SESSION_KEY);
      } catch {
        return null;
      }
      if (raw === null) return null;
      try {
        const value: unknown = JSON.parse(raw);
        if (isStoredSession(value)) return { serverUrl: value.serverUrl, endpoints: value.endpoints, refreshToken: value.refreshToken, orgSlug: value.orgSlug };
      } catch {
        // falls through to the removal below
      }
      await kv.remove(SESSION_KEY).catch(() => undefined);
      return null;
    },
    async save(session) {
      await kv.set(SESSION_KEY, JSON.stringify({ v: 1, ...session }));
    },
    async clear() {
      // Every key is tried even if one removal fails; the failure is then reported so the caller does not claim a clean store.
      let failed = false;
      for (const key of ALL_KEYS) {
        try {
          await kv.remove(key);
        } catch {
          failed = true;
        }
      }
      if (failed) throw new Error('the secure storage did not clear');
    },
  };
}

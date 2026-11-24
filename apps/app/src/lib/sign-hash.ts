// SPDX-License-Identifier: AGPL-3.0-only
// Token fragment helpers and offline Web Crypto SHA-256 hashing for eSign (#3325).
// The signing link carries its credential strictly in the URL fragment (#token) so the token
// never travels in HTTP query strings, server access logs, or Referer headers.

import { promoteMigratedItem, readLegacyAwareItem, removeMigratedItem, writeMigratedItem, type StorageLike } from './storage-migrate.ts';

export const SIGN_PAGE_PATH = '/-/sign';
export const SIGN_DIRECT_PAGE_PATH = '/-/sign/d';
export const SIGN_PUBLIC_HUB_PAGE_PREFIX = '/-/sign/p';
export const SIGN_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const SIGN_IN_PERSON_ISOLATED_SESSION_KEY = 'ludy.sign.in_person.isolated';

export function hasInPersonQueryFlag(search = typeof window !== 'undefined' ? window.location.search : ''): boolean {
  if (!search) return false;
  const params = new URLSearchParams(search.startsWith('?') ? search : `?${search}`);
  const flag = params.get('in_person');
  return flag === '1' || flag === 'true';
}

function getCeremonySessionStorage(): StorageLike | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}

export function isSignCeremonyPathname(pathname = typeof window !== 'undefined' ? window.location.pathname : ''): boolean {
  return pathname === SIGN_PAGE_PATH || pathname === `${SIGN_PAGE_PATH}/`;
}

const ceremonyIsolationListeners = new Set<() => void>();
let inPersonCeremonyIsolatedInMemory = false;

export function subscribeToCeremonyIsolation(listener: () => void): () => void {
  ceremonyIsolationListeners.add(listener);
  return () => {
    ceremonyIsolationListeners.delete(listener);
  };
}

export function markInPersonCeremonyIsolated(storage?: StorageLike): void {
  if (!storage) {
    inPersonCeremonyIsolatedInMemory = true;
  }
  const store = storage ?? getCeremonySessionStorage();
  if (store) {
    try {
      store.setItem(SIGN_IN_PERSON_ISOLATED_SESSION_KEY, '1');
    } catch {
      // Ignore storage quota or private browsing restrictions.
    }
  }
  if (!storage) {
    for (const listener of ceremonyIsolationListeners) {
      listener();
    }
  }
}

export function isInPersonCeremonyIsolated(
  storage?: StorageLike,
  location: { pathname?: string; search?: string } | undefined = typeof window !== 'undefined' ? window.location : undefined,
): boolean {
  if (!storage && inPersonCeremonyIsolatedInMemory) {
    return true;
  }
  const store = storage ?? getCeremonySessionStorage();
  try {
    if (store?.getItem(SIGN_IN_PERSON_ISOLATED_SESSION_KEY) === '1') {
      if (!storage) {
        inPersonCeremonyIsolatedInMemory = true;
      }
      return true;
    }
  } catch {
    // Fall through to URL inspection when storage is unavailable.
  }
  if (location && isSignCeremonyPathname(location.pathname ?? '') && hasInPersonQueryFlag(location.search ?? '')) {
    markInPersonCeremonyIsolated(storage);
    return true;
  }
  return false;
}

export function readSignTokenFromHash(hash = typeof window !== 'undefined' ? window.location.hash : ''): string | null {
  const outerTrimmed = hash.trim();
  const raw = outerTrimmed.startsWith('#') ? outerTrimmed.slice(1) : outerTrimmed;
  const trimmed = raw.trim();
  return SIGN_TOKEN_PATTERN.test(trimmed) ? trimmed : null;
}

const SIGN_TOKEN_SESSION_KEY = 'ludy.sign.ceremony.token';
const LEGACY_SIGN_TOKEN_SESSION_KEY = 'crove.sign.ceremony.token';
const SIGN_DIRECT_TOKEN_SESSION_KEY = 'ludy.sign.direct.token';
const LEGACY_SIGN_DIRECT_TOKEN_SESSION_KEY = 'crove.sign.direct.token';
const SIGN_TOKEN_SESSION_TTL_MS = 15 * 60 * 1000;

interface StoredSignToken {
  token: string;
  savedAt: number;
}

function writeSessionSignToken(storageKey: string, legacyKey: string, token: string): void {
  if (typeof window === 'undefined' || !SIGN_TOKEN_PATTERN.test(token)) return;
  try {
    const payload: StoredSignToken = { token, savedAt: Date.now() };
    writeMigratedItem(window.sessionStorage, storageKey, legacyKey, JSON.stringify(payload));
  } catch {
    // Ignore storage quota or private browsing restrictions.
  }
}

function readSessionSignToken(storageKey: string, legacyKey: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const entry = readLegacyAwareItem(window.sessionStorage, storageKey, legacyKey);
    if (!entry) return null;
    const parsed = JSON.parse(entry.value) as Partial<StoredSignToken> | null;
    if (
      !parsed ||
      typeof parsed.token !== 'string' ||
      !SIGN_TOKEN_PATTERN.test(parsed.token) ||
      typeof parsed.savedAt !== 'number' ||
      !Number.isFinite(parsed.savedAt) ||
      Date.now() - parsed.savedAt > SIGN_TOKEN_SESSION_TTL_MS
    ) {
      removeMigratedItem(window.sessionStorage, storageKey, legacyKey);
      return null;
    }
    if (entry.fromLegacy) promoteMigratedItem(window.sessionStorage, storageKey, legacyKey, entry.value);
    return parsed.token;
  } catch {
    try {
      removeMigratedItem(window.sessionStorage, storageKey, legacyKey);
    } catch {
      // Ignore storage access failures.
    }
    return null;
  }
}

function clearSessionSignToken(storageKey: string, legacyKey: string): void {
  if (typeof window === 'undefined') return;
  try {
    removeMigratedItem(window.sessionStorage, storageKey, legacyKey);
  } catch {
    // Ignore storage access failures.
  }
}

export function scrubSignTokenHash(): void {
  if (typeof window === 'undefined' || !window.location.hash) return;
  const cleanUrl = `${window.location.pathname}${window.location.search}`;
  window.history.replaceState(window.history.state ?? null, '', cleanUrl);
}

export function rememberSignToken(token: string): void {
  writeSessionSignToken(SIGN_TOKEN_SESSION_KEY, LEGACY_SIGN_TOKEN_SESSION_KEY, token);
}

export function pendingSignToken(): string | null {
  return readSessionSignToken(SIGN_TOKEN_SESSION_KEY, LEGACY_SIGN_TOKEN_SESSION_KEY);
}

export function forgetSignToken(): void {
  clearSessionSignToken(SIGN_TOKEN_SESSION_KEY, LEGACY_SIGN_TOKEN_SESSION_KEY);
}

export function rememberDirectSignToken(token: string): void {
  writeSessionSignToken(SIGN_DIRECT_TOKEN_SESSION_KEY, LEGACY_SIGN_DIRECT_TOKEN_SESSION_KEY, token);
}

export function pendingDirectSignToken(): string | null {
  return readSessionSignToken(SIGN_DIRECT_TOKEN_SESSION_KEY, LEGACY_SIGN_DIRECT_TOKEN_SESSION_KEY);
}

export function forgetDirectSignToken(): void {
  clearSessionSignToken(SIGN_DIRECT_TOKEN_SESSION_KEY, LEGACY_SIGN_DIRECT_TOKEN_SESSION_KEY);
}

export function subscribeToHash(onStoreChange: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener('hashchange', onStoreChange);
  return () => window.removeEventListener('hashchange', onStoreChange);
}

export function buildSigningUrl(token: string, origin = typeof window !== 'undefined' ? window.location.origin : ''): string {
  const cleanToken = token.trim();
  return `${origin}${SIGN_PAGE_PATH}#${cleanToken}`;
}

export function buildDirectSigningUrl(token: string, origin = typeof window !== 'undefined' ? window.location.origin : ''): string {
  const cleanToken = token.trim();
  return `${origin}${SIGN_DIRECT_PAGE_PATH}#${cleanToken}`;
}

export function buildInPersonSigningUrl(token: string, origin = typeof window !== 'undefined' ? window.location.origin : ''): string {
  const cleanToken = token.trim();
  return `${origin}${SIGN_PAGE_PATH}?in_person=1#${cleanToken}`;
}

export function buildPublicHubUrl(orgSlug: string, origin = typeof window !== 'undefined' ? window.location.origin : ''): string {
  const cleanSlug = encodeURIComponent(orgSlug.trim().toLowerCase());
  return `${origin}${SIGN_PUBLIC_HUB_PAGE_PREFIX}/${cleanSlug}`;
}

// Computes lowercase hex SHA-256 directly in the browser without uploading file bytes.
export async function sha256Hex(input: ArrayBuffer | Uint8Array): Promise<string> {
  const view = input instanceof Uint8Array ? input : new Uint8Array(input);
  const copy = new Uint8Array(view.byteLength);
  copy.set(view);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', copy.buffer);
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

export async function hashFileSha256(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  return sha256Hex(buffer);
}

// Writes text to the system clipboard and returns false when blocked by browser permissions.
export async function copyTextToClipboard(value: string): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
    return false;
  }
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

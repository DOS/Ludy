// SPDX-License-Identifier: AGPL-3.0-only
// Dual-read and one-time migration helpers for browser localStorage and sessionStorage keys (#3966).
// Reads the `ludy*` key first; when only the legacy `crove*` key is present, promotes it on read and removes the
// legacy entry best-effort so active sessions, preferences, and drafts carry over without failing in private windows.

export type StorageLike = Pick<Storage, 'getItem' | 'setItem'> & Partial<Pick<Storage, 'removeItem'>>;

function safeRemove(storage: StorageLike, key: string): void {
  try {
    storage.removeItem?.(key);
  } catch {
    // Ignore storage access failures on legacy key cleanup.
  }
}

export function promoteMigratedItem(storage: StorageLike, key: string, legacyKey: string, value: string): void {
  try {
    storage.setItem(key, value);
    safeRemove(storage, legacyKey);
  } catch {
    // Private mode or full storage may refuse writes; keep returning the value anyway.
  }
}

export function readMigratedItem(storage: StorageLike, key: string, legacyKey: string): string | null {
  const current = storage.getItem(key);
  if (current !== null) return current;
  const legacy = storage.getItem(legacyKey);
  if (legacy === null) return null;
  promoteMigratedItem(storage, key, legacyKey, legacy);
  return legacy;
}

export function readLegacyAwareItem(storage: StorageLike, key: string, legacyKey: string): { value: string; fromLegacy: boolean } | null {
  const current = storage.getItem(key);
  if (current !== null) return { value: current, fromLegacy: false };
  const legacy = storage.getItem(legacyKey);
  if (legacy === null) return null;
  return { value: legacy, fromLegacy: true };
}

export function writeMigratedItem(storage: StorageLike, key: string, legacyKey: string, value: string): void {
  storage.setItem(key, value);
  safeRemove(storage, legacyKey);
}

export function removeMigratedItem(storage: StorageLike, key: string, legacyKey: string): void {
  safeRemove(storage, key);
  safeRemove(storage, legacyKey);
}

export function takeMigratedItem(storage: StorageLike, key: string, legacyKey: string): string | null {
  const current = storage.getItem(key);
  const value = current !== null ? current : storage.getItem(legacyKey);
  removeMigratedItem(storage, key, legacyKey);
  return value;
}

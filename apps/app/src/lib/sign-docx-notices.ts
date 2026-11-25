// SPDX-License-Identifier: AGPL-3.0-only
// User- and org-scoped sessionStorage + bounded memory fallback for post-creation .docx warnings (#4729).
import { SIGN_DOCX_TO_PDF_WARNINGS, type SignDocxToPdfWarning } from '@ludy/kernel-contract';

const ENVELOPE_DOCX_WARNINGS_STORAGE_KEY = 'ludy.sign.created_docx_warnings';
const MAX_STORED_DOCX_NOTICES = 20;
const DOCX_NOTICE_TTL_MS = 24 * 60 * 60_000;
const ALLOWED_DOCX_WARNINGS = new Set<string>(SIGN_DOCX_TO_PDF_WARNINGS);

export interface CreatedDocxWarningScope {
  org?: string | null;
  userId?: string | null;
}

interface NormalizedScope {
  org: string;
  userId: string;
}

interface StoredDocxWarningNotice {
  envelopeId: string;
  org: string;
  userId: string;
  warnings: SignDocxToPdfWarning[];
  createdAt: number;
}

const fallbackDocxNotices = new Map<string, StoredDocxWarningNotice>();
const fallbackDismissedNotices = new Map<string, number>();
const knownStorageNoticeKeys = new Set<string>();
let pendingSignOutClear = false;

function normalizeScope(scope?: CreatedDocxWarningScope): NormalizedScope | null {
  const org = typeof scope?.org === 'string' ? scope.org.trim() : '';
  const userId = typeof scope?.userId === 'string' ? scope.userId.trim() : '';
  if (!org || !userId) return null;
  return { org, userId };
}

function noticeKey(envelopeId: string, scope: NormalizedScope): string {
  return `${scope.org}\0${scope.userId}\0${envelopeId}`;
}

/** Filters untrusted storage entries down to known contract warning codes. */
export function sanitizeDocxWarnings(raw: readonly unknown[]): SignDocxToPdfWarning[] {
  const seen = new Set<SignDocxToPdfWarning>();
  for (const item of raw) {
    if (typeof item === 'string' && ALLOWED_DOCX_WARNINGS.has(item)) {
      seen.add(item as SignDocxToPdfWarning);
    }
  }
  return [...seen];
}

function getDocxNoticeStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage ?? null;
  } catch {
    return null;
  }
}

function isFreshNotice(now: number, timestamp: number): boolean {
  return Number.isFinite(timestamp) && now - timestamp <= DOCX_NOTICE_TTL_MS && now >= timestamp;
}

function pruneFallbackDismissed(now: number): void {
  for (const [key, dismissedAt] of fallbackDismissedNotices) {
    if (!isFreshNotice(now, dismissedAt)) {
      fallbackDismissedNotices.delete(key);
    }
  }
}

function markFallbackDismissed(key: string, now: number): void {
  pruneFallbackDismissed(now);
  fallbackDismissedNotices.delete(key);
  fallbackDismissedNotices.set(key, now);
  while (fallbackDismissedNotices.size > MAX_STORED_DOCX_NOTICES) {
    const oldestKey = fallbackDismissedNotices.keys().next().value;
    if (oldestKey === undefined) break;
    fallbackDismissedNotices.delete(oldestKey);
  }
}

function readFallbackDocxNotices(now: number): StoredDocxWarningNotice[] {
  const valid: StoredDocxWarningNotice[] = [];
  for (const [key, entry] of fallbackDocxNotices) {
    if (!isFreshNotice(now, entry.createdAt) || entry.warnings.length === 0) {
      fallbackDocxNotices.delete(key);
    } else {
      valid.push(entry);
    }
  }
  return valid;
}

function readRawStorageResult(
  storage: Storage,
  now: number,
): { ok: true; entries: StoredDocxWarningNotice[] } | { ok: false; entries: StoredDocxWarningNotice[] } {
  try {
    const raw = storage.getItem(ENVELOPE_DOCX_WARNINGS_STORAGE_KEY);
    if (!raw) return { ok: true, entries: [] };
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return { ok: true, entries: [] };
    const byKey = new Map<string, StoredDocxWarningNotice>();
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue;
      const rec = item as Partial<StoredDocxWarningNotice>;
      if (
        typeof rec.envelopeId !== 'string' ||
        !rec.envelopeId ||
        typeof rec.org !== 'string' ||
        !rec.org.trim() ||
        typeof rec.userId !== 'string' ||
        !rec.userId.trim() ||
        typeof rec.createdAt !== 'number' ||
        !Array.isArray(rec.warnings)
      ) {
        continue;
      }
      if (!isFreshNotice(now, rec.createdAt)) continue;
      const warnings = sanitizeDocxWarnings(rec.warnings);
      if (warnings.length === 0) continue;
      const scope = { org: rec.org.trim(), userId: rec.userId.trim() };
      const entryKey = noticeKey(rec.envelopeId, scope);
      knownStorageNoticeKeys.add(entryKey);
      byKey.set(entryKey, {
        envelopeId: rec.envelopeId,
        org: scope.org,
        userId: scope.userId,
        warnings,
        createdAt: rec.createdAt,
      });
    }
    return { ok: true, entries: [...byKey.values()] };
  } catch {
    return { ok: false, entries: [] };
  }
}

function flushPendingSignOutClear(): Storage | null {
  const storage = getDocxNoticeStorage();
  if (!storage) return null;
  if (pendingSignOutClear) {
    try {
      storage.removeItem(ENVELOPE_DOCX_WARNINGS_STORAGE_KEY);
      knownStorageNoticeKeys.clear();
      pendingSignOutClear = false;
    } catch {
      return null;
    }
  }
  return storage;
}

function readMergedEntriesWithStorage(
  storage: Storage | null,
  now: number,
): { storageReadable: boolean; merged: StoredDocxWarningNotice[] } {
  pruneFallbackDismissed(now);
  const byKey = new Map<string, StoredDocxWarningNotice>();
  let storageReadable = false;
  if (storage) {
    const rawResult = readRawStorageResult(storage, now);
    storageReadable = rawResult.ok;
    for (const entry of rawResult.entries) {
      const key = noticeKey(entry.envelopeId, entry);
      if (!fallbackDismissedNotices.has(key)) {
        byKey.set(key, entry);
      }
    }
  }
  for (const fb of readFallbackDocxNotices(now)) {
    byKey.set(noticeKey(fb.envelopeId, fb), fb);
  }
  return { storageReadable, merged: [...byKey.values()] };
}

function readStoredDocxNotices(now: number): StoredDocxWarningNotice[] {
  const storage = flushPendingSignOutClear();
  const { storageReadable, merged } = readMergedEntriesWithStorage(storage, now);
  if (storage && storageReadable && (fallbackDocxNotices.size > 0 || fallbackDismissedNotices.size > 0)) {
    if (tryPersistDocxNotices(storage, merged)) {
      fallbackDocxNotices.clear();
      fallbackDismissedNotices.clear();
    }
  }
  return merged;
}

function tryPersistDocxNotices(storage: Storage, entries: readonly StoredDocxWarningNotice[]): boolean {
  const bounded = entries.slice(-MAX_STORED_DOCX_NOTICES);
  try {
    if (bounded.length === 0) {
      storage.removeItem(ENVELOPE_DOCX_WARNINGS_STORAGE_KEY);
    } else {
      storage.setItem(ENVELOPE_DOCX_WARNINGS_STORAGE_KEY, JSON.stringify(bounded));
    }
    knownStorageNoticeKeys.clear();
    for (const entry of bounded) {
      knownStorageNoticeKeys.add(noticeKey(entry.envelopeId, entry));
    }
    return true;
  } catch {
    return false;
  }
}

/** Persists post-creation .docx warnings scoped by user and org until explicitly dismissed or signed out (#4729). */
export function saveCreatedDocxWarnings(
  envelopeId: string,
  warnings: readonly SignDocxToPdfWarning[],
  scope?: CreatedDocxWarningScope,
  now = Date.now(),
): boolean {
  const norm = normalizeScope(scope);
  if (!envelopeId || !norm) return false;
  const clean = sanitizeDocxWarnings(warnings);
  if (clean.length === 0) {
    clearCreatedDocxWarnings(envelopeId, norm, now);
    return true;
  }
  const key = noticeKey(envelopeId, norm);
  const nextEntry: StoredDocxWarningNotice = {
    envelopeId,
    org: norm.org,
    userId: norm.userId,
    warnings: clean,
    createdAt: now,
  };
  const merged = readStoredDocxNotices(now).filter((entry) => noticeKey(entry.envelopeId, entry) !== key);
  merged.push(nextEntry);
  const storage = flushPendingSignOutClear();
  if (storage && tryPersistDocxNotices(storage, merged)) {
    fallbackDocxNotices.clear();
    fallbackDismissedNotices.clear();
    return true;
  }
  // Keep existing sessionStorage items intact on quota failures; track only the unpersisted update in memory.
  fallbackDismissedNotices.delete(key);
  fallbackDocxNotices.delete(key);
  fallbackDocxNotices.set(key, nextEntry);
  while (fallbackDocxNotices.size > MAX_STORED_DOCX_NOTICES) {
    const oldestKey = fallbackDocxNotices.keys().next().value;
    if (oldestKey === undefined) break;
    fallbackDocxNotices.delete(oldestKey);
  }
  return true;
}

/** Reads persisted post-creation .docx warnings matching envelope, user, and org without consuming them. */
export function readCreatedDocxWarnings(
  envelopeId: string,
  scope?: CreatedDocxWarningScope,
  now = Date.now(),
): SignDocxToPdfWarning[] {
  const norm = normalizeScope(scope);
  if (!envelopeId || !norm) return [];
  const key = noticeKey(envelopeId, norm);
  const match = readStoredDocxNotices(now).find((entry) => noticeKey(entry.envelopeId, entry) === key);
  return match ? [...match.warnings] : [];
}

/** Clears a dismissed envelope warning for the active user and org without holding unbounded IDs when storage is absent. */
export function clearCreatedDocxWarnings(
  envelopeId: string,
  scope?: CreatedDocxWarningScope,
  now = Date.now(),
): void {
  const norm = normalizeScope(scope);
  if (!envelopeId || !norm) return;
  const key = noticeKey(envelopeId, norm);
  fallbackDocxNotices.delete(key);
  const storage = flushPendingSignOutClear();
  if (!storage) {
    if (knownStorageNoticeKeys.has(key)) {
      markFallbackDismissed(key, now);
    }
    return;
  }

  const { storageReadable, merged } = readMergedEntriesWithStorage(storage, now);
  const remainingMerged = merged.filter((entry) => noticeKey(entry.envelopeId, entry) !== key);
  if (storageReadable && tryPersistDocxNotices(storage, remainingMerged)) {
    fallbackDocxNotices.clear();
    fallbackDismissedNotices.clear();
    return;
  }
  const rawResult = readRawStorageResult(storage, now);
  const remainingStorage = rawResult.entries.filter((entry) => noticeKey(entry.envelopeId, entry) !== key);
  if (rawResult.ok && tryPersistDocxNotices(storage, remainingStorage)) {
    fallbackDismissedNotices.delete(key);
  } else if (
    knownStorageNoticeKeys.has(key) ||
    (rawResult.ok && rawResult.entries.some((entry) => noticeKey(entry.envelopeId, entry) === key))
  ) {
    markFallbackDismissed(key, now);
  }
}

/** Drops all persisted and in-memory .docx warnings when signing out of the workspace (#4729). */
export function clearAllCreatedDocxWarnings(): void {
  fallbackDocxNotices.clear();
  fallbackDismissedNotices.clear();
  knownStorageNoticeKeys.clear();
  pendingSignOutClear = true;
  void flushPendingSignOutClear();
}

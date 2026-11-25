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

export interface PendingCreatedDocxNotice {
  envelopeId: string;
  slug: string;
  orgId: string | null;
  userId: string | null;
  sessionId?: string | null | undefined;
  envelopeTitle?: string | undefined;
  warnings: readonly SignDocxToPdfWarning[];
}

interface StoredPendingCreatedDocxNotice extends PendingCreatedDocxNotice {
  createdAt: number;
}

const fallbackDocxNotices = new Map<string, StoredDocxWarningNotice>();
const fallbackDismissedNotices = new Map<string, number>();
const pendingUnpersistedDocxNotices = new Map<string, StoredPendingCreatedDocxNotice>();
const pendingNoticeListeners = new Set<() => void>();
const knownStorageNoticeKeys = new Set<string>();
let pendingSignOutClear = false;
let docxNoticeAuthEpoch = 0;

function notifyPendingNoticeListeners(): void {
  for (const listener of Array.from(pendingNoticeListeners)) {
    listener();
  }
}

/** Subscribes to in-tab pending .docx list notice updates so newly mounted views see async completions (#4729). */
export function subscribePendingDocxListNotices(listener: () => void): () => void {
  pendingNoticeListeners.add(listener);
  return () => {
    pendingNoticeListeners.delete(listener);
  };
}

/** Monotonic counter incremented on every sign-out cleanup so late in-flight creates cannot restore stale notices (#4729). */
export function getDocxNoticeAuthEpoch(): number {
  return docxNoticeAuthEpoch;
}

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

function tryAccessSessionStorage(): { available: boolean; storage: Storage | null } {
  if (typeof window === 'undefined') return { available: true, storage: null };
  try {
    return { available: true, storage: window.sessionStorage ?? null };
  } catch {
    return { available: false, storage: null };
  }
}

function getDocxNoticeStorage(): Storage | null {
  return tryAccessSessionStorage().storage;
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
  let raw: string | null;
  try {
    raw = storage.getItem(ENVELOPE_DOCX_WARNINGS_STORAGE_KEY);
  } catch {
    return { ok: false, entries: [] };
  }
  if (!raw) {
    knownStorageNoticeKeys.clear();
    return { ok: true, entries: [] };
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      knownStorageNoticeKeys.clear();
      return { ok: true, entries: [] };
    }
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
      byKey.set(entryKey, {
        envelopeId: rec.envelopeId,
        org: scope.org,
        userId: scope.userId,
        warnings,
        createdAt: rec.createdAt,
      });
    }
    knownStorageNoticeKeys.clear();
    for (const k of byKey.keys()) {
      knownStorageNoticeKeys.add(k);
    }
    return { ok: true, entries: [...byKey.values()] };
  } catch {
    // Storage itself is readable; treat malformed JSON as empty so future saves can repair it.
    knownStorageNoticeKeys.clear();
    return { ok: true, entries: [] };
  }
}

function tryClearPendingSignOutStorage(storage: Storage): boolean {
  if (!pendingSignOutClear) return true;
  try {
    storage.removeItem(ENVELOPE_DOCX_WARNINGS_STORAGE_KEY);
    knownStorageNoticeKeys.clear();
    pendingSignOutClear = false;
    return true;
  } catch {
    return false;
  }
}

function flushPendingSignOutClear(): Storage | null {
  const storage = getDocxNoticeStorage();
  if (!storage) return null;
  if (!tryClearPendingSignOutStorage(storage)) {
    return null;
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

function readStoredDocxNoticesWithStatus(now: number): {
  storageReadable: boolean;
  notices: StoredDocxWarningNotice[];
} {
  const { available, storage } = tryAccessSessionStorage();
  if (!available) {
    return { storageReadable: false, notices: readFallbackDocxNotices(now) };
  }
  if (!storage) {
    return { storageReadable: true, notices: readFallbackDocxNotices(now) };
  }
  if (!tryClearPendingSignOutStorage(storage)) {
    return { storageReadable: false, notices: readFallbackDocxNotices(now) };
  }
  const { storageReadable, merged } = readMergedEntriesWithStorage(storage, now);
  if (storageReadable && (fallbackDocxNotices.size > 0 || fallbackDismissedNotices.size > 0)) {
    if (tryPersistDocxNotices(storage, merged)) {
      fallbackDocxNotices.clear();
      fallbackDismissedNotices.clear();
    }
  }
  return { storageReadable, notices: merged };
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
  const storage = flushPendingSignOutClear();
  const { storageReadable, merged } = readMergedEntriesWithStorage(storage, now);
  const nextMerged = merged.filter((entry) => noticeKey(entry.envelopeId, entry) !== key);
  nextMerged.push(nextEntry);
  if (storage && storageReadable && tryPersistDocxNotices(storage, nextMerged)) {
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

/** Reads persisted post-creation .docx warnings plus whether sessionStorage was readable during this read (#4729). */
export function readCreatedDocxWarningsWithStatus(
  envelopeId: string,
  scope?: CreatedDocxWarningScope,
  now = Date.now(),
): { storageReadable: boolean; warnings: SignDocxToPdfWarning[] } {
  const norm = normalizeScope(scope);
  if (!envelopeId || !norm) return { storageReadable: true, warnings: [] };
  const key = noticeKey(envelopeId, norm);
  const { storageReadable, notices } = readStoredDocxNoticesWithStatus(now);
  const match = notices.find((entry) => noticeKey(entry.envelopeId, entry) === key);
  return {
    storageReadable,
    warnings: match ? [...match.warnings] : [],
  };
}

/** Reads persisted post-creation .docx warnings matching envelope, user, and org without consuming them. */
export function readCreatedDocxWarnings(
  envelopeId: string,
  scope?: CreatedDocxWarningScope,
  now = Date.now(),
): SignDocxToPdfWarning[] {
  return readCreatedDocxWarningsWithStatus(envelopeId, scope, now).warnings;
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
  docxNoticeAuthEpoch += 1;
  const hadPending = pendingUnpersistedDocxNotices.size > 0;
  fallbackDocxNotices.clear();
  fallbackDismissedNotices.clear();
  pendingUnpersistedDocxNotices.clear();
  knownStorageNoticeKeys.clear();
  pendingSignOutClear = true;
  void flushPendingSignOutClear();
  if (hadPending) {
    notifyPendingNoticeListeners();
  }
}

function stripTimestamp({ createdAt: _ignored, ...rest }: StoredPendingCreatedDocxNotice): PendingCreatedDocxNotice {
  return rest;
}

function pruneFreshPendingNotices(now: number): void {
  for (const [id, entry] of pendingUnpersistedDocxNotices) {
    if (!isFreshNotice(now, entry.createdAt) || entry.warnings.length === 0) {
      pendingUnpersistedDocxNotices.delete(id);
    }
  }
}

/** Records an unpersisted .docx warning across list/detail navigations within the same session and org slug (#4729). */
export function upsertPendingDocxListNotice(notice: PendingCreatedDocxNotice, now = Date.now()): PendingCreatedDocxNotice[] {
  const cleanWarnings = sanitizeDocxWarnings(notice.warnings);
  if (!notice.envelopeId || !notice.slug || cleanWarnings.length === 0) {
    return [...pendingUnpersistedDocxNotices.values()].map(stripTimestamp);
  }
  pruneFreshPendingNotices(now);
  pendingUnpersistedDocxNotices.delete(notice.envelopeId);
  const next: StoredPendingCreatedDocxNotice = { ...notice, warnings: cleanWarnings, createdAt: now };
  const rebuilt = new Map<string, StoredPendingCreatedDocxNotice>([[notice.envelopeId, next]]);
  for (const [id, existing] of pendingUnpersistedDocxNotices) {
    if (rebuilt.size >= MAX_STORED_DOCX_NOTICES) break;
    rebuilt.set(id, existing);
  }
  pendingUnpersistedDocxNotices.clear();
  for (const [id, entry] of rebuilt) {
    pendingUnpersistedDocxNotices.set(id, entry);
  }
  notifyPendingNoticeListeners();
  return [...pendingUnpersistedDocxNotices.values()].map(stripTimestamp);
}

/** Removes a single unpersisted pending .docx notice once persisted or explicitly dismissed (#4729). */
export function removePendingDocxListNotice(envelopeId: string): PendingCreatedDocxNotice[] {
  const removed = pendingUnpersistedDocxNotices.delete(envelopeId);
  if (removed) {
    notifyPendingNoticeListeners();
  }
  return [...pendingUnpersistedDocxNotices.values()].map(stripTimestamp);
}

/** Clears unpersisted pending .docx notices matching an envelope/session/user scope or belonging to another account (#4729). */
export function clearPendingDocxListNotices(filter?: {
  envelopeId?: string | undefined;
  slug?: string | undefined;
  sessionId?: string | undefined;
  userId?: string | undefined;
  mismatchUserId?: string | null | undefined;
  mismatchSessionId?: string | null | undefined;
}): PendingCreatedDocxNotice[] {
  if (!filter) {
    const hadAny = pendingUnpersistedDocxNotices.size > 0;
    pendingUnpersistedDocxNotices.clear();
    if (hadAny) {
      notifyPendingNoticeListeners();
    }
    return [];
  }
  let changed = false;
  for (const [id, entry] of pendingUnpersistedDocxNotices) {
    if (filter.envelopeId && entry.envelopeId === filter.envelopeId) {
      pendingUnpersistedDocxNotices.delete(id);
      changed = true;
    } else if (filter.sessionId) {
      if (entry.sessionId === filter.sessionId) {
        pendingUnpersistedDocxNotices.delete(id);
        changed = true;
      }
    } else if (filter.userId && !entry.sessionId && entry.userId === filter.userId) {
      pendingUnpersistedDocxNotices.delete(id);
      changed = true;
    } else if (filter.slug && entry.slug === filter.slug) {
      pendingUnpersistedDocxNotices.delete(id);
      changed = true;
    } else if (filter.mismatchUserId !== undefined && entry.userId && entry.userId !== filter.mismatchUserId) {
      pendingUnpersistedDocxNotices.delete(id);
      changed = true;
    } else if (filter.mismatchSessionId && entry.sessionId && entry.sessionId !== filter.mismatchSessionId) {
      pendingUnpersistedDocxNotices.delete(id);
      changed = true;
    }
  }
  if (changed) {
    notifyPendingNoticeListeners();
  }
  return [...pendingUnpersistedDocxNotices.values()].map(stripTimestamp);
}

/** Probes local pending/memory/sessionStorage state, distinguishing empty readable storage from transient storage errors (#4729). */
export function probeLocalDocxNoticeCandidate(
  envelopeId: string,
  slug: string,
  now = Date.now(),
): 'present' | 'none' | 'storage_error' {
  if (!envelopeId) return 'none';
  if (slug && readPendingDocxListNotice(envelopeId, slug, now)) {
    return 'present';
  }
  if (readFallbackDocxNotices(now).some((entry) => entry.envelopeId === envelopeId)) {
    return 'present';
  }
  if (pendingSignOutClear) {
    void flushPendingSignOutClear();
    return 'none';
  }
  const { available, storage } = tryAccessSessionStorage();
  if (!available) {
    return 'storage_error';
  }
  if (!storage) {
    return 'none';
  }
  const rawResult = readRawStorageResult(storage, now);
  if (!rawResult.ok) {
    return 'storage_error';
  }
  const hasEntry = rawResult.entries.some(
    (entry) => entry.envelopeId === envelopeId && !fallbackDismissedNotices.has(noticeKey(entry.envelopeId, entry)),
  );
  return hasEntry ? 'present' : 'none';
}

/** Returns true when this tab holds a candidate or sessionStorage access failed transiently (#4729). */
export function hasLocalDocxNoticeCandidate(envelopeId: string, slug: string, now = Date.now()): boolean {
  return probeLocalDocxNoticeCandidate(envelopeId, slug, now) !== 'none';
}

/** Reads a single unpersisted pending .docx notice by envelope ID and workspace slug (#4729). */
export function readPendingDocxListNotice(
  envelopeId: string,
  slug: string,
  now = Date.now(),
): PendingCreatedDocxNotice | null {
  if (!envelopeId || !slug) return null;
  pruneFreshPendingNotices(now);
  const entry = pendingUnpersistedDocxNotices.get(envelopeId);
  if (!entry || entry.slug !== slug) return null;
  return stripTimestamp(entry);
}

/** Lists unpersisted pending .docx notices still valid for the given workspace slug and active user (#4729). */
export function listPendingDocxListNotices(
  slug: string,
  currentUserId: string | null = null,
  now = Date.now(),
): PendingCreatedDocxNotice[] {
  pruneFreshPendingNotices(now);
  const out: PendingCreatedDocxNotice[] = [];
  for (const entry of pendingUnpersistedDocxNotices.values()) {
    if (entry.slug !== slug) continue;
    if (currentUserId !== null && entry.userId && entry.userId !== currentUserId) continue;
    out.push(stripTimestamp(entry));
  }
  return out;
}

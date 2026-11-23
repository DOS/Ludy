// SPDX-License-Identifier: AGPL-3.0-only
// Per-org recent screens and records for the Cmd+K command palette (#4525):
// strictly scoped per org slug (+ orgId/userId guard), capped at 5 most-recent-first,
// resilient to SSR, private mode, QuotaExceededError, and corrupted JSON, and filtered
// against enabled modules and member permissions.
import { useCallback, useSyncExternalStore } from 'react';
import type { NavMessage, ShellVisibility } from './apps.ts';
import { moduleOfPath, screenInstalled } from './modules.ts';
import { MAX_PALETTE_RECENTS } from './palette.ts';

export const RECENT_STORAGE_PREFIX = 'ludy.palette.recent.';

export type RecentKind = 'screen' | 'record';

export interface RecentItem {
  id: string;
  path: string;
  label: string;
  detail?: string;
  kind: RecentKind;
  visitedAt: number;
}

export type RecentStorageLike = Pick<Storage, 'getItem' | 'setItem'> &
  Partial<Pick<Storage, 'removeItem' | 'key'>> & {
    readonly length?: number;
  };

export interface RecentScope {
  orgId?: string | undefined;
  userId?: string | undefined;
  storage?: RecentStorageLike | undefined;
}

export interface RecentVisibilityContext {
  modules: readonly string[];
  visibility: ShellVisibility;
}

interface StoredOrgRecents {
  version: 1;
  orgId?: string;
  userId?: string;
  items: RecentItem[];
}

const EMPTY_RECENTS: readonly RecentItem[] = [];

const STATIC_SOCIAL_SEGMENTS: ReadonlySet<string> = new Set([
  'new',
  'channels',
  'import',
  'snippets',
  'labels',
  'ideas',
  'feeds',
  'bio',
  'notifications',
  'inbox',
  'comments',
]);

const memoryStore = new Map<string, StoredOrgRecents>();
const memoryFailedKeys = new Set<string>();
const customFallbacks = new WeakMap<RecentStorageLike, { store: Map<string, StoredOrgRecents>; failedKeys: Set<string> }>();
const listenersBySlug = new Map<string, Set<() => void>>();
const snapshotCache = new Map<string, { cacheKey: string; items: readonly RecentItem[] }>();
let memoryRevision = 0;
let stopWindowStorageListener: (() => void) | null = null;

function browserStorageOrNull(): RecentStorageLike | null {
  try {
    return typeof window === 'undefined' ? null : (window.localStorage ?? null);
  } catch {
    return null;
  }
}

function fallbackStateFor(customStorage?: RecentStorageLike) {
  if (!customStorage) return { store: memoryStore, failedKeys: memoryFailedKeys };
  let entry = customFallbacks.get(customStorage);
  if (!entry) {
    entry = { store: new Map<string, StoredOrgRecents>(), failedKeys: new Set<string>() };
    customFallbacks.set(customStorage, entry);
  }
  return entry;
}

export function recentStorageKey(slug: string): string {
  return `${RECENT_STORAGE_PREFIX}${encodeURIComponent(slug)}`;
}

function decodeSegment(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Normalizes a full router pathname under `/o/<slug>/...` into an org-relative screen path
 * (for example `/ledger` or `/inbox/0190-abc`). Returns null for other orgs, non-org paths,
 * or paths with traversal segments.
 */
export function normalizeOrgRelativePath(pathname: string, slug: string): string | null {
  const trimmedSlug = slug.trim();
  if (!trimmedSlug) return null;
  const parts = pathname.split('/');
  if (parts[1] !== 'o') return null;
  if (decodeSegment(parts[2] ?? '') !== trimmedSlug) return null;
  const rawRest = parts.slice(3).filter((segment, index, arr) => !(index === arr.length - 1 && segment === ''));
  if (rawRest.length === 0) return null;
  for (const segment of rawRest) {
    const decoded = decodeSegment(segment);
    if (!segment || decoded === '.' || decoded === '..' || decoded.includes('\\') || hasControlChar(decoded)) {
      return null;
    }
  }
  return `/${rawRest.join('/')}`;
}

/** Strips query and hash fragments from an org-relative path and trims any trailing slash. */
export function stripSearchAndHash(relativePath: string): string {
  const qIndex = relativePath.indexOf('?');
  const hIndex = relativePath.indexOf('#');
  const cut =
    qIndex >= 0 && hIndex >= 0 ? Math.min(qIndex, hIndex) : qIndex >= 0 ? qIndex : hIndex >= 0 ? hIndex : relativePath.length;
  const base = relativePath.slice(0, cut).replace(/\/+$/, '');
  return base || '/';
}

/**
 * Validates and normalizes an org-relative path (such as `/ledger` or `/documents?q=123#row`).
 * Rejects protocol URLs, protocol-relative paths (`//`), `/o/` cross-org prefixes, and `..` segments.
 */
export function sanitizeRecentRelativePath(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 512 || !trimmed.startsWith('/') || trimmed.startsWith('//')) return null;
  if (hasControlChar(trimmed)) return null;
  const qIndex = trimmed.indexOf('?');
  const hIndex = trimmed.indexOf('#');
  const splitAt = qIndex >= 0 && hIndex >= 0 ? Math.min(qIndex, hIndex) : qIndex >= 0 ? qIndex : hIndex >= 0 ? hIndex : trimmed.length;
  const rawPath = trimmed.slice(0, splitAt);
  const suffix = trimmed.slice(splitAt);
  if (rawPath.includes('://') || rawPath.includes('\\')) return null;
  const segments = rawPath.split('/').filter((segment, index, arr) => !(index === 0 && segment === '') && !(index === arr.length - 1 && segment === ''));
  if (segments.length === 0) return null;
  if (decodeSegment(segments[0] ?? '').toLowerCase() === 'o') return null;
  for (const segment of segments) {
    const decoded = decodeSegment(segment);
    if (!segment || decoded === '.' || decoded === '..') return null;
  }
  return `/${segments.join('/')}${suffix}`;
}

/** Maps a parameterized detail route pathname (for example `/inbox/123`) to its parent NavMessage, or null for screens. */
export function detailSectionKeyForPath(relativePathname: string): NavMessage | null {
  const clean = stripSearchAndHash(relativePathname).toLowerCase();
  const segments = clean.split('/').filter(Boolean);
  const [first, second, third] = segments;
  if (segments.length === 2 && second) {
    if (first === 'inbox') return 'inbox';
    if (first === 'tasks') return 'tasks';
    if (first === 'projects') return 'projects';
    if (first === 'meetings' && second !== 'record') return 'meetings';
    if (first === 'social' && !STATIC_SOCIAL_SEGMENTS.has(second)) return 'social';
  }
  if (segments.length === 3 && first === 'sign' && second === 'envelopes' && third) {
    return 'signEnvelopes';
  }
  return null;
}

/** True when a stored recent item points to a known declared route whose module and permissions are currently active. */
export function isRecentItemVisible(item: Pick<RecentItem, 'path'>, ctx: RecentVisibilityContext): boolean {
  const sanitized = sanitizeRecentRelativePath(item.path);
  if (!sanitized) return false;
  const pathname = stripSearchAndHash(sanitized).toLowerCase();
  if (pathname.startsWith('/print/')) return false;
  const syntheticPath = `/o/org${pathname}`;
  if (moduleOfPath(syntheticPath) === null) return false;
  if (!screenInstalled(ctx.modules, syntheticPath)) return false;
  if (pathname === '/hr/my' || pathname.startsWith('/hr/my/')) return ctx.visibility.hrMember;
  if (pathname === '/hr' || pathname.startsWith('/hr/')) return ctx.visibility.manager;
  if (pathname === '/ai-usage' || pathname.startsWith('/ai-usage/')) return ctx.visibility.manager;
  if (pathname === '/ai-connections' || pathname.startsWith('/ai-connections/')) return ctx.visibility.showAiConnections;
  if (pathname === '/audit' || pathname.startsWith('/audit/')) return ctx.visibility.manager;
  return true;
}

export function filterVisibleRecentItems(items: readonly RecentItem[], ctx: RecentVisibilityContext): RecentItem[] {
  return items.filter((item) => isRecentItemVisible(item, ctx));
}

function sanitizeStoredItem(raw: unknown): RecentItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.id !== 'string' || !record.id.trim()) return null;
  const path = sanitizeRecentRelativePath(record.path);
  if (!path) return null;
  if (typeof record.label !== 'string') return null;
  const label = record.label.trim().slice(0, 200);
  if (!label) return null;
  if (record.kind !== 'screen' && record.kind !== 'record') return null;
  const visitedAt = typeof record.visitedAt === 'number' && Number.isFinite(record.visitedAt) ? record.visitedAt : 0;
  const detail = typeof record.detail === 'string' && record.detail.trim() ? record.detail.trim().slice(0, 200) : undefined;
  return {
    id: record.id.trim().slice(0, 512),
    path,
    label,
    ...(detail !== undefined ? { detail } : {}),
    kind: record.kind,
    visitedAt,
  };
}

function deduplicateAndCap(items: readonly RecentItem[]): RecentItem[] {
  const seenIds = new Set<string>();
  const seenPaths = new Set<string>();
  const out: RecentItem[] = [];
  for (const item of items) {
    if (seenIds.has(item.id) || seenPaths.has(item.path)) continue;
    seenIds.add(item.id);
    seenPaths.add(item.path);
    out.push(item);
    if (out.length >= MAX_PALETTE_RECENTS) break;
  }
  return out;
}

function parseStoredPayload(raw: string): StoredOrgRecents | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  if (obj.version !== 1 || !Array.isArray(obj.items)) return null;
  const orgId = typeof obj.orgId === 'string' && obj.orgId.trim() ? obj.orgId.trim() : undefined;
  const userId = typeof obj.userId === 'string' && obj.userId.trim() ? obj.userId.trim() : undefined;
  const sanitized = deduplicateAndCap(obj.items.flatMap((entry) => {
    const clean = sanitizeStoredItem(entry);
    return clean ? [clean] : [];
  }));
  return {
    version: 1,
    ...(orgId !== undefined ? { orgId } : {}),
    ...(userId !== undefined ? { userId } : {}),
    items: sanitized,
  };
}

function scopeMatches(stored: StoredOrgRecents, scope?: RecentScope): boolean {
  if (scope?.orgId && stored.orgId && stored.orgId !== scope.orgId) return false;
  if (scope?.userId && stored.userId && stored.userId !== scope.userId) return false;
  return true;
}

function readRawPayload(slug: string, scope?: RecentScope): { payload: StoredOrgRecents | null; cacheKey: string } {
  const key = recentStorageKey(slug);
  const store = scope?.storage ?? browserStorageOrNull();
  const fallback = fallbackStateFor(scope?.storage);
  if (!store || fallback.failedKeys.has(key)) {
    const mem = fallback.store.get(key) ?? null;
    return { payload: mem, cacheKey: `mem:${memoryRevision}:${mem?.orgId ?? ''}:${mem?.userId ?? ''}` };
  }
  try {
    const raw = store.getItem(key);
    if (raw === null) {
      return { payload: null, cacheKey: 'raw:null' };
    }
    const parsed = parseStoredPayload(raw);
    return { payload: parsed, cacheKey: `raw:${raw}` };
  } catch {
    const mem = fallback.store.get(key) ?? null;
    return { payload: mem, cacheKey: `mem:${memoryRevision}:${mem?.orgId ?? ''}:${mem?.userId ?? ''}` };
  }
}

/** Reads up to 5 recent screens/records strictly scoped to `slug` (and optional `orgId`/`userId`). */
export function readRecentItems(slug: string, scope?: RecentScope): readonly RecentItem[] {
  const trimmedSlug = slug.trim();
  if (!trimmedSlug) return EMPTY_RECENTS;
  if (!scope?.storage && typeof window === 'undefined') return EMPTY_RECENTS;
  const { payload, cacheKey } = readRawPayload(trimmedSlug, scope);
  if (!payload || !scopeMatches(payload, scope) || payload.items.length === 0) {
    return EMPTY_RECENTS;
  }
  if (!scope?.storage) {
    const fullKey = `${trimmedSlug}|${scope?.orgId ?? ''}|${scope?.userId ?? ''}|${cacheKey}`;
    const cached = snapshotCache.get(trimmedSlug);
    if (cached && cached.cacheKey === fullKey) return cached.items;
    snapshotCache.set(trimmedSlug, { cacheKey: fullKey, items: payload.items });
    return payload.items;
  }
  return payload.items;
}

function notifySlugListeners(slug: string): void {
  const set = listenersBySlug.get(slug);
  if (!set) return;
  for (const listener of set) listener();
}

function notifyAllListeners(): void {
  for (const set of listenersBySlug.values()) {
    for (const listener of set) listener();
  }
}

/** Records a visited screen or record most-recent-first for `slug`, capped at 5 deduplicated entries. */
export function recordRecentItem(
  slug: string,
  item: Omit<RecentItem, 'visitedAt'> & { visitedAt?: number },
  scope?: RecentScope,
): readonly RecentItem[] {
  const trimmedSlug = slug.trim();
  if (!trimmedSlug) return EMPTY_RECENTS;
  if (!scope?.storage && typeof window === 'undefined') return EMPTY_RECENTS;

  const clean = sanitizeStoredItem({
    ...item,
    visitedAt: item.visitedAt ?? Date.now(),
  });
  if (!clean) return readRecentItems(trimmedSlug, scope);

  const key = recentStorageKey(trimmedSlug);
  const store = scope?.storage ?? browserStorageOrNull();
  const fallback = fallbackStateFor(scope?.storage);
  const { payload: existingPayload } = readRawPayload(trimmedSlug, scope);
  const previous = existingPayload && scopeMatches(existingPayload, scope) ? existingPayload.items : [];
  const nextItems = deduplicateAndCap([clean, ...previous]);
  const orgId = scope?.orgId ?? (existingPayload && scopeMatches(existingPayload, scope) ? existingPayload.orgId : undefined);
  const userId = scope?.userId ?? (existingPayload && scopeMatches(existingPayload, scope) ? existingPayload.userId : undefined);
  const nextPayload: StoredOrgRecents = {
    version: 1,
    ...(orgId ? { orgId } : {}),
    ...(userId ? { userId } : {}),
    items: nextItems,
  };

  memoryRevision += 1;
  fallback.store.set(key, nextPayload);
  if (store) {
    try {
      store.setItem(key, JSON.stringify(nextPayload));
      fallback.failedKeys.delete(key);
    } catch {
      fallback.failedKeys.add(key);
    }
  }
  if (!scope?.storage) {
    snapshotCache.delete(trimmedSlug);
    notifySlugListeners(trimmedSlug);
  }
  return nextItems;
}

/** Clears recent items for one org `slug`, or all orgs when `slug` is omitted (for example on sign-out). */
export function clearRecentItems(slug?: string, customStorage?: RecentStorageLike): void {
  const store = customStorage ?? browserStorageOrNull();
  const fallback = fallbackStateFor(customStorage);
  memoryRevision += 1;

  if (slug !== undefined) {
    const trimmed = slug.trim();
    if (!trimmed) return;
    const key = recentStorageKey(trimmed);
    fallback.store.delete(key);
    fallback.failedKeys.delete(key);
    if (store) {
      try {
        store.removeItem?.(key);
      } catch {
        // Ignore storage removal errors in restricted windows.
      }
    }
    if (!customStorage) {
      snapshotCache.delete(trimmed);
      notifySlugListeners(trimmed);
    }
    return;
  }

  fallback.store.clear();
  fallback.failedKeys.clear();
  if (store && typeof store.length === 'number' && typeof store.key === 'function') {
    try {
      const keysToRemove: string[] = [];
      for (let i = 0; i < store.length; i += 1) {
        const k = store.key(i);
        if (typeof k === 'string' && k.startsWith(RECENT_STORAGE_PREFIX)) keysToRemove.push(k);
      }
      for (const k of keysToRemove) {
        try {
          store.removeItem?.(k);
        } catch {
          // Ignore individual removal errors.
        }
      }
    } catch {
      // Ignore storage enumeration failures.
    }
  }
  if (!customStorage) {
    snapshotCache.clear();
    notifyAllListeners();
  }
}

function attachWindowStorageSync(): void {
  if (stopWindowStorageListener || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
  const onStorage = (event: StorageEvent) => {
    if (event.storageArea && event.storageArea !== browserStorageOrNull()) return;
    if (event.key === null) {
      memoryStore.clear();
      memoryFailedKeys.clear();
      snapshotCache.clear();
      memoryRevision += 1;
      notifyAllListeners();
      return;
    }
    if (!event.key.startsWith(RECENT_STORAGE_PREFIX)) return;
    const encodedSlug = event.key.slice(RECENT_STORAGE_PREFIX.length);
    const affectedSlug = decodeSegment(encodedSlug);
    memoryFailedKeys.delete(event.key);
    memoryStore.delete(event.key);
    snapshotCache.delete(affectedSlug);
    memoryRevision += 1;
    notifySlugListeners(affectedSlug);
  };
  window.addEventListener('storage', onStorage);
  stopWindowStorageListener = () => {
    window.removeEventListener('storage', onStorage);
    stopWindowStorageListener = null;
  };
}

export function subscribeRecentItems(slug: string, listener: () => void): () => void {
  const trimmed = slug.trim();
  if (!trimmed) return () => {};
  let set = listenersBySlug.get(trimmed);
  if (!set) {
    set = new Set();
    listenersBySlug.set(trimmed, set);
  }
  set.add(listener);
  attachWindowStorageSync();
  return () => {
    const currentSet = listenersBySlug.get(trimmed);
    currentSet?.delete(listener);
    if (currentSet && currentSet.size === 0) listenersBySlug.delete(trimmed);
    if (listenersBySlug.size === 0) stopWindowStorageListener?.();
  };
}

export function useRecentItems(slug: string, scope?: Omit<RecentScope, 'storage'>): readonly RecentItem[] {
  const subscribe = useCallback((listener: () => void) => subscribeRecentItems(slug, listener), [slug]);
  return useSyncExternalStore(
    subscribe,
    () => readRecentItems(slug, scope),
    () => EMPTY_RECENTS,
  );
}

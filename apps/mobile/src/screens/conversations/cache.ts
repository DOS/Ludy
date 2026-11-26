// SPDX-License-Identifier: AGPL-3.0-only
// Offline-tolerant persisted read cache for mobile Engage conversations, written atomically with epoch, abort, and generation isolation.

import type { KeyValue } from '../../auth/vault.ts';
import {
  DEFAULT_SALES_COWORKER,
  type ConversationCounts,
  type ConversationDetail,
  type ConversationFilterTab,
  type ConversationSummary,
} from './model.ts';

const META_KEY = 'ludy.conversations.cache.meta.v1';
const STAGE_KEY = 'ludy.conversations.cache.stage.v1';
const CLEANUP_KEY = 'ludy.conversations.cache.cleanup.v1';
const GEN_CHUNK_PREFIX = 'ludy.conversations.cache.v1.';
const CACHE_VERSION = 1;
const MAX_CHUNKS = 32;
const MAX_CHUNK_BYTES = 1600;
const MAX_LIST_ITEMS = 30;
const MAX_CACHED_THREADS = 15;
const MAX_THREAD_MESSAGES = 40;
const MAX_PREVIEW_LEN = 200;
const MAX_BODY_LEN = 1200;
const MAX_SUGGESTIONS = 5;
const MAX_NOTES = 20;
const MAX_OTHERS = 10;

export interface CachedConversationThread {
  conversationId: string;
  cachedAt: number;
  detail: ConversationDetail;
}

export interface CachedConversationsSnapshot {
  v: 1;
  serverUrl: string;
  orgSlug: string;
  userId: string;
  savedAt: number;
  salesCoworkerName: string;
  counts: ConversationCounts | null;
  lists: Partial<Record<ConversationFilterTab, ConversationSummary[]>>;
  threads: Record<string, CachedConversationThread>;
}

interface CacheWriteOptions {
  expectedEpoch?: number;
  signal?: AbortSignal;
  isSessionStillActive?: () => boolean;
}

export interface ConversationsCache {
  epoch(): number;
  load(serverUrl: string, orgSlug: string, userId: string | null): Promise<CachedConversationsSnapshot | null>;
  save(snapshot: Omit<CachedConversationsSnapshot, 'v'>, options?: CacheWriteOptions): Promise<boolean>;
  upsertList(
    params: {
      serverUrl: string;
      orgSlug: string;
      userId: string | null;
      savedAt: number;
      filter: ConversationFilterTab;
      items: ConversationSummary[];
      counts?: ConversationCounts | null;
      salesCoworkerName?: string;
    } & CacheWriteOptions,
  ): Promise<CachedConversationsSnapshot | null>;
  upsertThread(
    params: {
      serverUrl: string;
      orgSlug: string;
      userId: string | null;
      savedAt: number;
      detail: ConversationDetail;
      salesCoworkerName?: string;
    } & CacheWriteOptions,
  ): Promise<CachedConversationsSnapshot | null>;
  evictThread(
    params: {
      serverUrl: string;
      orgSlug: string;
      userId: string | null;
      conversationId: string;
    } & CacheWriteOptions,
  ): Promise<void>;
  clearScope(params: { serverUrl: string; orgSlug: string; userId?: string | null }): Promise<void>;
  clear(): Promise<void>;
}

const encoder = new TextEncoder();

function truncateText(value: string | null | undefined, max: number): string {
  if (!value) return '';
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}...`;
}

function splitUtf8Chunks(text: string, maxBytes: number): string[] {
  if (!text) return [''];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + maxBytes);
    while (end > start && encoder.encode(text.slice(start, end)).length > maxBytes) {
      end = start + Math.max(1, Math.floor((end - start) * 0.75));
    }
    if (end < text.length) {
      const code = text.charCodeAt(end - 1);
      if (code >= 0xd800 && code <= 0xdbff) end -= 1;
    }
    if (end <= start) end = start + 1;
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}

interface CacheMeta {
  v: number;
  gen: number;
  serverUrl: string;
  orgSlug: string;
  userId: string;
  savedAt: number;
  chunks: number;
}

interface CacheStage {
  v: number;
  gen: number;
  chunks: number;
}

function isCacheMeta(raw: unknown): raw is CacheMeta {
  if (!raw || typeof raw !== 'object') return false;
  const candidate = raw as Record<string, unknown>;
  return (
    candidate.v === CACHE_VERSION &&
    typeof candidate.gen === 'number' &&
    Number.isInteger(candidate.gen) &&
    candidate.gen >= 1 &&
    typeof candidate.serverUrl === 'string' &&
    typeof candidate.orgSlug === 'string' &&
    typeof candidate.userId === 'string' &&
    candidate.userId.length > 0 &&
    typeof candidate.savedAt === 'number' &&
    Number.isFinite(candidate.savedAt) &&
    typeof candidate.chunks === 'number' &&
    Number.isInteger(candidate.chunks) &&
    candidate.chunks >= 1 &&
    candidate.chunks <= MAX_CHUNKS
  );
}

function isCacheStage(raw: unknown): raw is CacheStage {
  if (!raw || typeof raw !== 'object') return false;
  const candidate = raw as Record<string, unknown>;
  return (
    candidate.v === CACHE_VERSION &&
    typeof candidate.gen === 'number' &&
    Number.isInteger(candidate.gen) &&
    candidate.gen >= 1 &&
    typeof candidate.chunks === 'number' &&
    Number.isInteger(candidate.chunks) &&
    candidate.chunks >= 1 &&
    candidate.chunks <= MAX_CHUNKS
  );
}

function sanitizeSummary(c: ConversationSummary): ConversationSummary {
  return {
    ...c,
    preview: truncateText(c.preview, MAX_PREVIEW_LEN),
    contact: {
      ...c.contact,
      displayName: c.contact.displayName ? truncateText(c.contact.displayName, 160) : null,
      partyName: c.contact.partyName ? truncateText(c.contact.partyName, 160) : null,
    },
    channel: {
      ...c.channel,
      displayName: truncateText(c.channel.displayName, 120),
    },
    ...(c.subject !== undefined ? { subject: c.subject ? truncateText(c.subject, 200) : null } : {}),
  };
}

function sanitizeDetail(detail: ConversationDetail): ConversationDetail {
  return {
    ...detail,
    conversation: sanitizeSummary(detail.conversation),
    messages: detail.messages.slice(-MAX_THREAD_MESSAGES).map((m) => ({
      ...m,
      body: m.removed ? '' : truncateText(m.body, MAX_BODY_LEN),
      authorName: m.authorName ? truncateText(m.authorName, 160) : null,
    })),
    notes: detail.notes.slice(-MAX_NOTES).map((n) => ({
      ...n,
      body: truncateText(n.body, 500),
    })),
    draft: detail.draft
      ? {
          ...detail.draft,
          body: detail.draft.body !== null ? truncateText(detail.draft.body, MAX_BODY_LEN) : null,
        }
      : null,
    suggestions: detail.suggestions.slice(0, MAX_SUGGESTIONS).map((s) => ({
      ...s,
      title: truncateText(s.title, 100),
      body: truncateText(s.body, MAX_BODY_LEN),
    })),
    others: detail.others.slice(0, MAX_OTHERS),
  };
}

function sanitizeSnapshot(input: Omit<CachedConversationsSnapshot, 'v'>): CachedConversationsSnapshot {
  const lists: Partial<Record<ConversationFilterTab, ConversationSummary[]>> = {};
  for (const tab of ['new', 'pending', 'all'] as const) {
    const arr = input.lists[tab];
    if (Array.isArray(arr)) {
      lists[tab] = arr.slice(0, MAX_LIST_ITEMS).map(sanitizeSummary);
    }
  }

  const orderedThreads = Object.values(input.threads)
    .sort((a, b) => b.cachedAt - a.cachedAt)
    .slice(0, MAX_CACHED_THREADS);
  const threads: Record<string, CachedConversationThread> = {};
  for (const entry of orderedThreads) {
    threads[entry.conversationId] = {
      conversationId: entry.conversationId,
      cachedAt: entry.cachedAt,
      detail: sanitizeDetail(entry.detail),
    };
  }

  return {
    v: CACHE_VERSION,
    serverUrl: input.serverUrl,
    orgSlug: input.orgSlug,
    userId: input.userId,
    savedAt: input.savedAt,
    salesCoworkerName: truncateText(input.salesCoworkerName || DEFAULT_SALES_COWORKER, 100) || DEFAULT_SALES_COWORKER,
    counts: input.counts ?? null,
    lists,
    threads,
  };
}

function isCachedSnapshotBody(
  raw: unknown,
): raw is Pick<CachedConversationsSnapshot, 'salesCoworkerName' | 'counts' | 'lists' | 'threads'> {
  if (!raw || typeof raw !== 'object') return false;
  const obj = raw as Record<string, unknown>;
  return (
    typeof obj.salesCoworkerName === 'string' &&
    typeof obj.lists === 'object' &&
    obj.lists !== null &&
    typeof obj.threads === 'object' &&
    obj.threads !== null
  );
}

function chunkKey(gen: number, index: number): string {
  return `${GEN_CHUNK_PREFIX}${gen}.${index}`;
}

interface PendingCleanupEntry {
  gen: number;
  chunks: number;
}

function isCleanupList(raw: unknown): raw is PendingCleanupEntry[] {
  if (!Array.isArray(raw)) return false;
  return raw.every((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    const item = entry as Record<string, unknown>;
    return (
      typeof item.gen === 'number' &&
      Number.isInteger(item.gen) &&
      item.gen >= 1 &&
      typeof item.chunks === 'number' &&
      Number.isInteger(item.chunks) &&
      item.chunks >= 1 &&
      item.chunks <= MAX_CHUNKS
    );
  });
}

function fitSnapshotChunks(snapshot: CachedConversationsSnapshot): {
  chunks: string[];
  fitted: CachedConversationsSnapshot;
} {
  let threadEntries = Object.values(snapshot.threads).sort((a, b) => b.cachedAt - a.cachedAt);
  let listLimit = MAX_LIST_ITEMS;
  let newestMsgLimit = MAX_THREAD_MESSAGES;
  let dropExtras = false;

  while (true) {
    const boundedThreads: Record<string, CachedConversationThread> = {};
    for (const t of threadEntries) {
      if (threadEntries.length === 1 && (dropExtras || newestMsgLimit < t.detail.messages.length)) {
        boundedThreads[t.conversationId] = {
          ...t,
          detail: {
            ...t.detail,
            messages: t.detail.messages.slice(-newestMsgLimit),
            ...(dropExtras ? { notes: [], others: [], suggestions: t.detail.suggestions.slice(0, 2) } : {}),
          },
        };
      } else {
        boundedThreads[t.conversationId] = t;
      }
    }
    const retainedIds = new Set(threadEntries.map((t) => t.conversationId));
    const boundedLists: Partial<Record<ConversationFilterTab, ConversationSummary[]>> = {};
    for (const tab of ['new', 'pending', 'all'] as const) {
      const arr = snapshot.lists[tab];
      if (!arr) continue;
      if (listLimit <= 0) {
        boundedLists[tab] = [];
        continue;
      }
      if (retainedIds.size === 0 || arr.length <= listLimit) {
        boundedLists[tab] = arr.slice(0, listLimit);
        continue;
      }
      const chosen = new Set<number>();
      for (let i = 0; i < arr.length && chosen.size < listLimit; i++) {
        const item = arr[i];
        if (item && retainedIds.has(item.id)) chosen.add(i);
      }
      for (let i = 0; i < arr.length && chosen.size < listLimit; i++) {
        chosen.add(i);
      }
      boundedLists[tab] = arr.filter((_, i) => chosen.has(i));
    }
    const bodyJson = JSON.stringify({
      salesCoworkerName: snapshot.salesCoworkerName,
      counts: snapshot.counts,
      lists: boundedLists,
      threads: boundedThreads,
    });
    const chunks = splitUtf8Chunks(bodyJson, MAX_CHUNK_BYTES);
    if (chunks.length <= MAX_CHUNKS) {
      return {
        chunks,
        fitted: {
          ...snapshot,
          lists: boundedLists,
          threads: boundedThreads,
        },
      };
    }
    // Preserve inbox list reachability for retained threads: shrink extra threads first, keep >= 1 list item while threads exist, then trim thread payload before dropping threads/lists.
    if (threadEntries.length > 1) {
      threadEntries = threadEntries.slice(0, Math.max(1, Math.floor(threadEntries.length / 2)));
      continue;
    }
    const minListLimit = threadEntries.length > 0 ? 1 : 0;
    if (listLimit > minListLimit) {
      listLimit = Math.max(minListLimit, Math.floor(listLimit / 2));
      continue;
    }
    if (threadEntries.length === 1 && !dropExtras) {
      dropExtras = true;
      continue;
    }
    if (threadEntries.length === 1 && newestMsgLimit > 1) {
      newestMsgLimit = Math.max(1, Math.floor(newestMsgLimit / 2));
      continue;
    }
    if (threadEntries.length === 1) {
      threadEntries = [];
      continue;
    }
    const emptySnapshot: CachedConversationsSnapshot = {
      ...snapshot,
      lists: {},
      threads: {},
    };
    return {
      chunks: splitUtf8Chunks(
        JSON.stringify({
          salesCoworkerName: snapshot.salesCoworkerName,
          counts: snapshot.counts,
          lists: {},
          threads: {},
        }),
        MAX_CHUNK_BYTES,
      ),
      fitted: emptySnapshot,
    };
  }
}

export function createConversationsCache(store: KeyValue): ConversationsCache {
  let clearEpoch = 0;
  let highestGen = 0;
  let lock = Promise.resolve();

  const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = lock.then(fn, fn);
    lock = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  function isWriteStale(options?: CacheWriteOptions): boolean {
    if (options?.expectedEpoch !== undefined && options.expectedEpoch !== clearEpoch) return true;
    if (options?.signal?.aborted) return true;
    if (options?.isSessionStillActive && !options.isSessionStillActive()) return true;
    return false;
  }

  async function readMeta(): Promise<CacheMeta | null> {
    const raw = await store.get(META_KEY);
    if (!raw) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      return isCacheMeta(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  async function readStage(): Promise<CacheStage | null> {
    const raw = await store.get(STAGE_KEY);
    if (!raw) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      return isCacheStage(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  async function readCleanup(): Promise<PendingCleanupEntry[]> {
    const raw = await store.get(CLEANUP_KEY);
    if (!raw) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      return isCleanupList(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  async function removeChunks(gen: number, count: number): Promise<void> {
    for (let i = 0; i < count; i++) {
      await store.remove(chunkKey(gen, i));
    }
  }

  async function flushPendingCleanups(entries: PendingCleanupEntry[], activeGen?: number): Promise<void> {
    if (entries.length === 0) return;
    for (const entry of entries) {
      if (activeGen !== undefined && entry.gen === activeGen) continue;
      await removeChunks(entry.gen, entry.chunks);
    }
    await store.remove(CLEANUP_KEY);
  }

  async function loadUnlocked(
    serverUrl: string,
    orgSlug: string,
    userId: string | null,
  ): Promise<CachedConversationsSnapshot | null> {
    if (!userId) return null;
    const meta = await readMeta();
    if (!meta || meta.serverUrl !== serverUrl || meta.orgSlug !== orgSlug || meta.userId !== userId) {
      return null;
    }
    const parts: string[] = [];
    for (let i = 0; i < meta.chunks; i++) {
      const part = await store.get(chunkKey(meta.gen, i));
      if (part === null) return null;
      parts.push(part);
    }
    try {
      const parsed: unknown = JSON.parse(parts.join(''));
      if (!isCachedSnapshotBody(parsed)) return null;
      return {
        v: CACHE_VERSION,
        serverUrl: meta.serverUrl,
        orgSlug: meta.orgSlug,
        userId: meta.userId,
        savedAt: meta.savedAt,
        salesCoworkerName: parsed.salesCoworkerName,
        counts: parsed.counts ?? null,
        lists: parsed.lists,
        threads: parsed.threads,
      };
    } catch {
      return null;
    }
  }

  async function saveUnlocked(
    snapshot: Omit<CachedConversationsSnapshot, 'v'>,
    options?: CacheWriteOptions,
  ): Promise<CachedConversationsSnapshot | null> {
    if (!snapshot.userId || isWriteStale(options)) return null;

    const previous = await readMeta();
    const staged = await readStage();
    const pendingCleanup = await readCleanup();
    const maxCleanupGen = pendingCleanup.reduce((acc, e) => Math.max(acc, e.gen), 0);
    const nextGen = (Math.max(highestGen, previous?.gen ?? 0, staged?.gen ?? 0, maxCleanupGen) % 1_000_000) + 1;
    highestGen = nextGen;

    const sanitized = sanitizeSnapshot(snapshot);
    const { chunks, fitted } = fitSnapshotChunks(sanitized);

    if (staged && staged.gen !== previous?.gen) {
      await removeChunks(staged.gen, staged.chunks);
    }

    if (isWriteStale(options)) {
      await store.remove(STAGE_KEY);
      return null;
    }

    const nextStage: CacheStage = { v: CACHE_VERSION, gen: nextGen, chunks: chunks.length };
    await store.set(STAGE_KEY, JSON.stringify(nextStage));

    for (let i = 0; i < chunks.length; i++) {
      await store.set(chunkKey(nextGen, i), chunks[i] ?? '');
    }

    // Re-check epoch, abort signal, and active session right before flipping META_KEY.
    if (isWriteStale(options)) {
      await removeChunks(nextGen, chunks.length);
      await store.remove(STAGE_KEY);
      return null;
    }

    // Record previous generation in CLEANUP_KEY before overwriting META_KEY so an interrupted cleanup never strands PII chunks.
    const toClean = [...pendingCleanup];
    if (previous && previous.gen !== nextGen && !toClean.some((e) => e.gen === previous.gen)) {
      toClean.push({ gen: previous.gen, chunks: previous.chunks });
    }
    if (toClean.length > 0) {
      await store.set(CLEANUP_KEY, JSON.stringify(toClean));
    }

    const meta: CacheMeta = {
      v: CACHE_VERSION,
      gen: nextGen,
      serverUrl: fitted.serverUrl,
      orgSlug: fitted.orgSlug,
      userId: fitted.userId,
      savedAt: fitted.savedAt,
      chunks: chunks.length,
    };
    await store.set(META_KEY, JSON.stringify(meta));
    await store.remove(STAGE_KEY);
    await flushPendingCleanups(toClean, nextGen);

    return fitted;
  }

  async function clearStoredUnlocked(scope?: {
    serverUrl: string;
    orgSlug: string;
    userId?: string | null;
  }): Promise<void> {
    const meta = await readMeta();
    const staged = await readStage();
    const pendingCleanup = await readCleanup();
    const metaMatchesScope =
      !scope ||
      !meta ||
      (meta.serverUrl === scope.serverUrl &&
        meta.orgSlug === scope.orgSlug &&
        (!scope.userId || meta.userId === scope.userId));

    const toClean: PendingCleanupEntry[] = [...pendingCleanup];
    if (metaMatchesScope && meta && !toClean.some((e) => e.gen === meta.gen)) {
      toClean.push({ gen: meta.gen, chunks: meta.chunks });
    }
    if (staged && (!meta || metaMatchesScope || staged.gen !== meta.gen) && !toClean.some((e) => e.gen === staged.gen)) {
      toClean.push({ gen: staged.gen, chunks: staged.chunks });
    }
    if (toClean.length > 0) {
      // Persist chunk cleanup manifest BEFORE removing META_KEY so an interrupted clear() never strands PII chunks.
      await store.set(CLEANUP_KEY, JSON.stringify(toClean));
    }
    if (metaMatchesScope) {
      await store.remove(META_KEY);
    }
    const keepGen = !metaMatchesScope && meta ? meta.gen : undefined;
    for (const entry of toClean) {
      highestGen = Math.max(highestGen, entry.gen);
      if (keepGen !== undefined && entry.gen === keepGen) continue;
      await removeChunks(entry.gen, entry.chunks);
    }
    await store.remove(CLEANUP_KEY);
    // Remove STAGE_KEY strictly last after all chunks are cleaned up.
    await store.remove(STAGE_KEY);
  }

  return {
    epoch() {
      return clearEpoch;
    },

    load(serverUrl, orgSlug, userId) {
      if (!userId) return Promise.resolve(null);
      return serialize(() => loadUnlocked(serverUrl, orgSlug, userId));
    },

    save(snapshot, options) {
      if (!snapshot.userId || isWriteStale(options)) return Promise.resolve(false);
      return serialize(async () => (await saveUnlocked(snapshot, options)) !== null);
    },

    upsertList(params) {
      if (!params.userId || isWriteStale(params)) return Promise.resolve(null);
      const userId = params.userId;
      return serialize(async () => {
        if (isWriteStale(params)) return null;
        const existing = await loadUnlocked(params.serverUrl, params.orgSlug, userId);
        const next: Omit<CachedConversationsSnapshot, 'v'> = {
          serverUrl: params.serverUrl,
          orgSlug: params.orgSlug,
          userId,
          savedAt: params.savedAt,
          salesCoworkerName: params.salesCoworkerName ?? existing?.salesCoworkerName ?? DEFAULT_SALES_COWORKER,
          counts: params.counts !== undefined ? params.counts : (existing?.counts ?? null),
          lists: {
            ...existing?.lists,
            [params.filter]: params.items,
          },
          threads: existing?.threads ?? {},
        };
        return saveUnlocked(next, params);
      });
    },

    upsertThread(params) {
      if (!params.userId || isWriteStale(params)) return Promise.resolve(null);
      const userId = params.userId;
      return serialize(async () => {
        if (isWriteStale(params)) return null;
        const existing = await loadUnlocked(params.serverUrl, params.orgSlug, userId);
        const conv = params.detail.conversation;
        const statusTab: ConversationFilterTab | null =
          conv.status === 'new' || conv.status === 'pending' ? conv.status : null;
        const nextLists: Partial<Record<ConversationFilterTab, ConversationSummary[]>> = {};
        for (const tab of ['new', 'pending', 'all'] as const) {
          const arr = existing?.lists[tab];
          const shouldContain = tab === 'all' || tab === statusTab;
          if (!arr) {
            if (shouldContain) nextLists[tab] = [conv];
            continue;
          }
          if (!shouldContain) {
            nextLists[tab] = arr.filter((item) => item.id !== conv.id);
          } else if (arr.some((item) => item.id === conv.id)) {
            nextLists[tab] = arr.map((item) => (item.id === conv.id ? conv : item));
          } else {
            nextLists[tab] = [...arr.slice(0, Math.max(0, MAX_LIST_ITEMS - 1)), conv];
          }
        }
        const next: Omit<CachedConversationsSnapshot, 'v'> = {
          serverUrl: params.serverUrl,
          orgSlug: params.orgSlug,
          userId,
          savedAt: params.savedAt,
          salesCoworkerName: params.salesCoworkerName ?? existing?.salesCoworkerName ?? DEFAULT_SALES_COWORKER,
          counts: existing?.counts ?? null,
          lists: nextLists,
          threads: {
            ...existing?.threads,
            [conv.id]: {
              conversationId: conv.id,
              cachedAt: params.savedAt,
              detail: params.detail,
            },
          },
        };
        return saveUnlocked(next, params);
      });
    },

    evictThread(params) {
      if (!params.userId || isWriteStale(params)) return Promise.resolve();
      const userId = params.userId;
      return serialize(async () => {
        if (isWriteStale(params)) return;
        const existing = await loadUnlocked(params.serverUrl, params.orgSlug, userId);
        if (!existing) return;
        const nextThreads = { ...existing.threads };
        const hadThread = Object.hasOwn(nextThreads, params.conversationId);
        delete nextThreads[params.conversationId];

        let changedList = false;
        const nextLists: Partial<Record<ConversationFilterTab, ConversationSummary[]>> = {};
        for (const tab of ['new', 'pending', 'all'] as const) {
          const arr = existing.lists[tab];
          if (!arr) continue;
          const filtered = arr.filter((item) => item.id !== params.conversationId);
          if (filtered.length !== arr.length) changedList = true;
          nextLists[tab] = filtered;
        }
        if (!hadThread && !changedList) return;

        await saveUnlocked(
          {
            serverUrl: existing.serverUrl,
            orgSlug: existing.orgSlug,
            userId: existing.userId,
            savedAt: existing.savedAt,
            salesCoworkerName: existing.salesCoworkerName,
            counts: existing.counts,
            lists: nextLists,
            threads: nextThreads,
          },
          params,
        );
      });
    },

    clearScope(params) {
      clearEpoch += 1;
      return serialize(() => clearStoredUnlocked(params));
    },

    clear() {
      clearEpoch += 1;
      return serialize(() => clearStoredUnlocked());
    },
  };
}

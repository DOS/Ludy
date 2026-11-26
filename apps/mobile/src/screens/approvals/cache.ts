// SPDX-License-Identifier: AGPL-3.0-only
// Offline-tolerant persisted read cache for the mobile approvals queue, written atomically with epoch and generation isolation.

import type { KeyValue } from '../../auth/vault.ts';

const META_KEY = 'ludy.approvals.cache.meta.v1';
const STAGE_KEY = 'ludy.approvals.cache.stage.v1';
const LEGACY_CHUNK_PREFIX = 'ludy.approvals.cache.chunk.v1.';
const GEN_CHUNK_PREFIX = 'ludy.approvals.cache.v1.';
const CACHE_VERSION = 1;
const MAX_CHUNKS = 32;
const MAX_CHUNK_BYTES = 1600;
const MAX_ITEMS = 60;
const MAX_TODAY_ITEMS = 40;
const MAX_TEXT_LEN = 280;

export type ApprovalSourceKind =
  | 'inbox'
  | 'social_post'
  | 'hr_leave'
  | 'hr_salary_advance'
  | 'hr_business_trip';

export type AiCoworkerId = 'gm' | 'finance' | 'sales' | 'marketing' | 'unknown';

export interface CachedApprovalSummary {
  key: string;
  source: ApprovalSourceKind;
  id: string;
  subtype: string;
  title: string;
  subtitle: string;
  counterparty: string | null;
  amount: string | null;
  currency: string | null;
  requiresStepUp: boolean;
  requiresNetwork: true;
  createdAt: string | null;
  dateLabel: string | null;
  failedChecks: number;
  warnChecks: number;
  anomalyChecks?: number;
  unclassifiedLines: number;
  aiCoworker: { id: AiCoworkerId; label: string } | null;
  webPath: string;
  multiDecisionOnly: boolean;
  multiDecisionReason: 'multiple_channels' | 'insufficient_role' | 'unsupported_on_mobile' | null;
  revision: number | null;
  leaveStatus?: string;
  socialChannelsCount?: number;
}

export interface CachedTodayNotice {
  key: string;
  kind: 'proposal' | 'flag' | 'message' | 'deadline';
  app: string;
  id: string;
  titleKey: string;
  titleParams?: Record<string, string | number>;
  amount: string | null;
  currency: string | null;
  count: number | null;
  dueAt: string | null;
  severity: 'info' | 'warn' | 'block' | null;
  webPath: string;
  aiCoworkerLabel: string | null;
}

export interface CachedCoworkerDirectory {
  gm?: string;
  finance?: string;
  sales?: string;
  marketing?: string;
}

export interface CachedApprovalsSnapshot {
  v: 1;
  serverUrl: string;
  orgSlug: string;
  userId: string;
  savedAt: number;
  items: CachedApprovalSummary[];
  todayNotices: CachedTodayNotice[];
  coworkers: CachedCoworkerDirectory;
}

export interface ApprovalsCache {
  epoch(): number;
  load(serverUrl: string, orgSlug: string, userId: string | null): Promise<CachedApprovalsSnapshot | null>;
  save(snapshot: Omit<CachedApprovalsSnapshot, 'v'>, options?: { expectedEpoch?: number }): Promise<boolean>;
  clear(): Promise<void>;
}

const encoder = new TextEncoder();

function truncateText(value: string | null | undefined, max = MAX_TEXT_LEN): string {
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

function sanitizeParams(
  params: Record<string, string | number> | undefined,
): Record<string, string | number> | undefined {
  if (!params) return undefined;
  const out: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(params)) {
    out[truncateText(key, 60)] = typeof value === 'string' ? truncateText(value, 140) : value;
  }
  return out;
}

function sanitizeSnapshot(input: Omit<CachedApprovalsSnapshot, 'v'>): CachedApprovalsSnapshot {
  return {
    v: CACHE_VERSION,
    serverUrl: input.serverUrl,
    orgSlug: input.orgSlug,
    userId: input.userId,
    savedAt: input.savedAt,
    coworkers: input.coworkers,
    items: input.items.slice(0, MAX_ITEMS).map((item) => ({
      ...item,
      title: truncateText(item.title),
      subtitle: truncateText(item.subtitle),
      counterparty: item.counterparty ? truncateText(item.counterparty, 120) : null,
    })),
    todayNotices: input.todayNotices.slice(0, MAX_TODAY_ITEMS).map((notice) => ({
      ...notice,
      titleKey: truncateText(notice.titleKey, 120),
      ...(notice.titleParams ? { titleParams: sanitizeParams(notice.titleParams) } : {}),
    })),
  };
}

function isCachedSnapshotBody(
  raw: unknown,
): raw is Omit<CachedApprovalsSnapshot, 'v' | 'serverUrl' | 'orgSlug' | 'userId' | 'savedAt'> {
  if (!raw || typeof raw !== 'object') return false;
  const obj = raw as Record<string, unknown>;
  return (
    Array.isArray(obj.items) &&
    Array.isArray(obj.todayNotices) &&
    typeof obj.coworkers === 'object' &&
    obj.coworkers !== null
  );
}

function chunkKey(gen: number, index: number): string {
  return `${GEN_CHUNK_PREFIX}${gen}.${index}`;
}

function fitSnapshotChunks(snapshot: CachedApprovalsSnapshot): string[] {
  let itemLimit = snapshot.items.length;
  let noticeLimit = snapshot.todayNotices.length;

  while (true) {
    const bodyJson = JSON.stringify({
      items: snapshot.items.slice(0, itemLimit),
      todayNotices: snapshot.todayNotices.slice(0, noticeLimit),
      coworkers: snapshot.coworkers,
    });
    const chunks = splitUtf8Chunks(bodyJson, MAX_CHUNK_BYTES);
    if (chunks.length <= MAX_CHUNKS) return chunks;
    if (noticeLimit > 0) {
      noticeLimit = Math.floor(noticeLimit / 2);
      continue;
    }
    if (itemLimit > 0) {
      itemLimit = Math.floor(itemLimit / 2);
      continue;
    }
    return splitUtf8Chunks(JSON.stringify({ items: [], todayNotices: [], coworkers: {} }), MAX_CHUNK_BYTES);
  }
}

export function createApprovalsCache(store: KeyValue): ApprovalsCache {
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

  async function removeChunks(gen: number, count: number): Promise<void> {
    for (let i = 0; i < count; i++) {
      await store.remove(chunkKey(gen, i));
    }
  }

  return {
    epoch() {
      return clearEpoch;
    },

    load(serverUrl, orgSlug, userId) {
      if (!userId) return Promise.resolve(null);
      return serialize(async () => {
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
            items: parsed.items,
            todayNotices: parsed.todayNotices,
            coworkers: parsed.coworkers,
          };
        } catch {
          return null;
        }
      });
    },

    save(snapshot, options) {
      const expectedEpoch = options?.expectedEpoch;
      if (!snapshot.userId) return Promise.resolve(false);
      if (expectedEpoch !== undefined && expectedEpoch !== clearEpoch) {
        return Promise.resolve(false);
      }
      return serialize(async () => {
        if (expectedEpoch !== undefined && expectedEpoch !== clearEpoch) return false;

        const previous = await readMeta();
        const staged = await readStage();
        const nextGen = (Math.max(highestGen, previous?.gen ?? 0, staged?.gen ?? 0) % 1_000_000) + 1;
        highestGen = nextGen;

        const sanitized = sanitizeSnapshot(snapshot);
        const chunks = fitSnapshotChunks(sanitized);

        // Clean up any leftover chunks from an earlier interrupted write before starting a new generation.
        if (staged && staged.gen !== previous?.gen) {
          await removeChunks(staged.gen, staged.chunks);
        }

        const nextStage: CacheStage = { v: CACHE_VERSION, gen: nextGen, chunks: chunks.length };
        await store.set(STAGE_KEY, JSON.stringify(nextStage));

        for (let i = 0; i < chunks.length; i++) {
          await store.set(chunkKey(nextGen, i), chunks[i] ?? '');
        }

        // Re-check clearEpoch before flipping META_KEY so an interleaved clear() discards this write safely.
        if (expectedEpoch !== undefined && expectedEpoch !== clearEpoch) {
          await removeChunks(nextGen, chunks.length);
          await store.remove(STAGE_KEY);
          return false;
        }

        const meta: CacheMeta = {
          v: CACHE_VERSION,
          gen: nextGen,
          serverUrl: sanitized.serverUrl,
          orgSlug: sanitized.orgSlug,
          userId: sanitized.userId,
          savedAt: sanitized.savedAt,
          chunks: chunks.length,
        };
        await store.set(META_KEY, JSON.stringify(meta));
        await store.remove(STAGE_KEY);

        if (previous && previous.gen !== nextGen) {
          await removeChunks(previous.gen, previous.chunks);
        }
        return true;
      });
    },

    clear() {
      // Increment synchronously before queuing so any in-flight save from an older epoch aborts cleanly.
      clearEpoch += 1;
      return serialize(async () => {
        const meta = await readMeta();
        const staged = await readStage();
        await store.remove(META_KEY);
        if (meta) {
          highestGen = Math.max(highestGen, meta.gen);
          await removeChunks(meta.gen, meta.chunks);
        }
        if (staged) {
          highestGen = Math.max(highestGen, staged.gen);
          if (!meta || staged.gen !== meta.gen) {
            await removeChunks(staged.gen, staged.chunks);
          }
        }
        for (let i = 0; i < MAX_CHUNKS; i++) {
          await store.remove(`${LEGACY_CHUNK_PREFIX}${i}`);
        }
        await store.remove(STAGE_KEY);
      });
    },
  };
}

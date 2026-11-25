// SPDX-License-Identifier: AGPL-3.0-only
// Unit tests for eSign .docx HTTP upload authorization ordering, rate-limiter key bounding,
// expiring LRU finalization cache, filename cleanup, and inflight caps (#4729 items 3 & 4).
import { randomUUID } from 'node:crypto';
import { crc32, deflateRawSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DomainError,
  contentGeneration,
  sha256Hex,
  type BlobStore,
  type Runtime,
} from '@ludy/kernel-runtime';
import type { SignDocxConvertCompletedResult } from '@ludy/kernel-contract';
import type { SignDocxConvertStatus } from '@ludy/mod-sign';
import type { AuthUser } from '../src/auth.ts';
import {
  ExpiringLruCache,
  SIGN_DOCX_FINALIZED_MAX_ENTRIES,
  SIGN_DOCX_FINALIZED_TTL_MS,
  SIGN_DOCX_INFLIGHT_MAX_ENTRIES,
  SIGN_DOCX_PER_MINUTE,
  SIGN_DOCX_RATE_LIMIT_MAX_KEYS,
  getSignDocxRuntimeStats,
  handleSignDocxConvertPoll,
  handleSignDocxConvertUpload,
} from '../src/sign-docx-http.ts';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const PDF_BYTES = new Uint8Array(Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n', 'utf8'));
const PDF_SHA = sha256Hex(PDF_BYTES);

function makeMinimalZipBytes(): Uint8Array {
  const data = Buffer.from('<w:document/>', 'utf8');
  const body = deflateRawSync(data);
  const name = Buffer.from('word/document.xml', 'utf8');
  const crc = crc32(data) >>> 0;
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x800, 6);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(body.byteLength, 18);
  local.writeUInt32LE(data.byteLength, 22);
  local.writeUInt16LE(name.byteLength, 26);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x800, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(body.byteLength, 20);
  central.writeUInt32LE(data.byteLength, 24);
  central.writeUInt16LE(name.byteLength, 28);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.byteLength + name.byteLength, 12);
  eocd.writeUInt32LE(local.byteLength + name.byteLength + body.byteLength, 16);
  return new Uint8Array(Buffer.concat([local, name, body, central, name, eocd]));
}

const VALID_DOCX_BYTES = makeMinimalZipBytes();
const VALID_DOCX_SHA = sha256Hex(VALID_DOCX_BYTES);

function makeUploadRequest(filename = 'hop-dong.docx'): Request {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(VALID_DOCX_BYTES)], { type: DOCX_MIME }), filename);
  return new Request('http://localhost/api/sign/convert-docx', {
    method: 'POST',
    body: form,
  });
}

function makeUser(userId = randomUUID(), extra: Partial<AuthUser> = {}): AuthUser {
  return {
    userId,
    email: 'member@example.vn',
    name: 'Member',
    aal: 'aal2',
    sessionId: randomUUID(),
    mfaAt: Math.floor(Date.now() / 1000),
    ...extra,
  };
}

function makeMemoryStore(): BlobStore & { putCalls: string[]; getCalls: string[] } {
  const blobs = new Map<string, Uint8Array>();
  const putCalls: string[] = [];
  const getCalls: string[] = [];
  return {
    putCalls,
    getCalls,
    async put(key, bytes) {
      putCalls.push(key);
      blobs.set(key, new Uint8Array(bytes));
      return contentGeneration(sha256Hex(bytes));
    },
    async get(key) {
      getCalls.push(key);
      const found = blobs.get(key);
      if (!found) throw new Error(`missing blob: ${key}`);
      return found;
    },
    async delete(key) {
      blobs.delete(key);
    },
  };
}

describe('sign-docx-http authorization ordering and cache/limiter hardening (#4729)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs SIGN_WRITERS role check before reading upload body, spending limiter budget, or writing to BlobStore', async () => {
    const store = makeMemoryStore();
    const calls: string[] = [];
    const runtime = {
      query: vi.fn(async (name: string) => {
        calls.push(`query:${name}`);
        if (name === 'sign.docx_convert.authorize') {
          throw new DomainError('FORBIDDEN', 403, 'Không đủ quyền');
        }
        throw new Error(`unexpected query: ${name}`);
      }),
      execute: vi.fn(async (name: string) => {
        calls.push(`execute:${name}`);
        return {};
      }),
    } as unknown as Runtime;

    let bodyChunksRead = 0;
    const unconsumedStream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          bodyChunksRead += 1;
          controller.enqueue(new Uint8Array([1, 2, 3]));
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const req = new Request('http://localhost/api/sign/convert-docx', {
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data; boundary=---test' },
      body: unconsumedStream,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });

    await expect(
      handleSignDocxConvertUpload({
        runtime,
        store,
        user: makeUser(),
        orgId: randomUUID(),
        req,
        waitMs: 0,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });

    expect(calls).toEqual(['query:sign.docx_convert.authorize']);
    expect(bodyChunksRead).toBe(0);
    expect(req.bodyUsed).toBe(false);
    expect(store.putCalls).toEqual([]);
    expect(getSignDocxRuntimeStats(runtime)).toBeNull();
  });

  it('evicts LRU entries on capacity and purges expired entries on read and write in ExpiringLruCache', () => {
    const cache = new ExpiringLruCache<string>(2, 1_000);
    cache.set('k1', 'v1', 100);
    cache.set('k2', 'v2', 200);
    // Touch k1 so k2 becomes the least recently used entry.
    expect(cache.get('k1', 300)).toBe('v1');
    cache.set('k3', 'v3', 400);
    expect(cache.size).toBe(2);
    expect(cache.get('k2', 450)).toBeUndefined();
    expect(cache.get('k1', 450)).toBe('v1');
    expect(cache.get('k3', 450)).toBe('v3');

    // Past TTL: expired entries are deleted on get and swept on next set.
    expect(cache.get('k1', 1_100)).toBeUndefined();
    expect(cache.size).toBe(1);
    cache.set('k4', 'v4', 1_500);
    expect(cache.size).toBe(1);
    expect(cache.get('k3', 1_500)).toBeUndefined();
    expect(cache.get('k4', 1_500)).toBe('v4');
  });

  it('bounds rate-limiter keys under burst traffic and reclaims refilled buckets after 1 minute', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-25T00:00:00.000Z'));

    const store = makeMemoryStore();
    const orgId = randomUUID();
    const runtime = {
      query: vi.fn(async (name: string) => {
        if (name === 'sign.docx_convert.authorize') return { ok: true };
        if (name === 'sign.docx_convert.status') return { status: 'pending', jobId: randomUUID() };
        throw new Error(`unexpected query: ${name}`);
      }),
      execute: vi.fn(async () => ({})),
    } as unknown as Runtime;

    // 1. Single actor exceeds SIGN_DOCX_PER_MINUTE -> 429 before reading body or touching BlobStore.
    const repeatUser = makeUser();
    let retryAfter = 0;
    for (let i = 0; i < SIGN_DOCX_PER_MINUTE; i++) {
      await handleSignDocxConvertUpload({
        runtime,
        store,
        user: repeatUser,
        orgId,
        req: makeUploadRequest(),
        waitMs: 0,
      });
    }
    const putsBeforeLimit = store.putCalls.length;
    await expect(
      handleSignDocxConvertUpload({
        runtime,
        store,
        user: repeatUser,
        orgId,
        req: makeUploadRequest(),
        waitMs: 0,
        onRateLimited: (sec) => {
          retryAfter = sec;
        },
      }),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED', status: 429 });
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(store.putCalls.length).toBe(putsBeforeLimit);

    // 2. Burst of distinct keys past SIGN_DOCX_RATE_LIMIT_MAX_KEYS stays bounded and refuses overflow.
    const invalidContentReq = () =>
      new Request('http://localhost/api/sign/convert-docx', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      });

    for (let i = 1; i < SIGN_DOCX_RATE_LIMIT_MAX_KEYS; i++) {
      await expect(
        handleSignDocxConvertUpload({
          runtime,
          store,
          user: makeUser(randomUUID()),
          orgId,
          req: invalidContentReq(),
          waitMs: 0,
        }),
      ).rejects.toMatchObject({ code: 'INVALID', status: 400 });
    }
    expect(getSignDocxRuntimeStats(runtime)?.rateLimiterKeys).toBe(SIGN_DOCX_RATE_LIMIT_MAX_KEYS);

    await expect(
      handleSignDocxConvertUpload({
        runtime,
        store,
        user: makeUser(randomUUID()),
        orgId,
        req: invalidContentReq(),
        waitMs: 0,
      }),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED', status: 429 });
    expect(getSignDocxRuntimeStats(runtime)?.rateLimiterKeys).toBe(SIGN_DOCX_RATE_LIMIT_MAX_KEYS);

    // After 1 minute, full buckets are swept and a new user key is accepted.
    vi.advanceTimersByTime(61_000);
    await expect(
      handleSignDocxConvertUpload({
        runtime,
        store,
        user: makeUser(randomUUID()),
        orgId,
        req: invalidContentReq(),
        waitMs: 0,
      }),
    ).rejects.toMatchObject({ code: 'INVALID', status: 400 });
    expect(getSignDocxRuntimeStats(runtime)?.rateLimiterKeys).toBeLessThanOrEqual(1);
  });

  it('bounds finalized cache with LRU/TTL, cleans filename entries, clones cached results, and caps inflight finalizations', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-25T01:00:00.000Z'));

    const store = makeMemoryStore();
    const orgId = randomUUID();
    const user = makeUser();
    const pdfStorageKey = `tmp/${orgId}/${PDF_SHA}`;
    await store.put(pdfStorageKey, PDF_BYTES, 'application/pdf');

    const statuses = new Map<string, SignDocxConvertStatus>();
    let ingestSeq = 0;
    const runtime = {
      query: vi.fn(async (name: string, input: { jobId?: string }) => {
        if (name === 'sign.docx_convert.authorize') return { ok: true };
        if (name === 'sign.docx_convert.status') {
          const st = statuses.get(input.jobId ?? '');
          if (st) return st;
          return { status: 'pending', jobId: input.jobId };
        }
        throw new Error(`unexpected query: ${name}`);
      }),
      execute: vi.fn(async (name: string) => {
        if (name === 'kernel.file.ingest') {
          ingestSeq += 1;
          return { fileId: `file-${ingestSeq}`, duplicate: false };
        }
        return {};
      }),
    } as unknown as Runtime;

    const addCompletedJob = (jobId: string) => {
      statuses.set(jobId, {
        status: 'completed',
        jobId,
        inputSha256: VALID_DOCX_SHA,
        inputStorageKey: `tmp/${orgId}/${VALID_DOCX_SHA}`,
        pdfSha256: PDF_SHA,
        pdfStorageKey,
        pdfSizeBytes: PDF_BYTES.byteLength,
        pageCount: 1,
        warnings: ['images_skipped'],
        errorCode: null,
      });
    };

    // Upload 1 job so filename cache gets populated, then finalize -> filename entry is cleared immediately.
    const uploaded = await handleSignDocxConvertUpload({
      runtime,
      store,
      user,
      orgId,
      req: makeUploadRequest('hop-dong-1.docx'),
      waitMs: 0,
    });
    expect(uploaded.status).toBe('pending');
    if (uploaded.status !== 'pending') throw new Error('expected pending');
    expect(getSignDocxRuntimeStats(runtime)?.filenameEntries).toBe(1);

    addCompletedJob(uploaded.jobId);
    const firstPoll = (await handleSignDocxConvertPoll({
      runtime,
      store,
      user,
      orgId,
      jobId: uploaded.jobId,
    })) as SignDocxConvertCompletedResult;
    expect(firstPoll.status).toBe('completed');
    expect(firstPoll.filename).toBe('hop-dong-1.pdf');
    expect(getSignDocxRuntimeStats(runtime)?.filenameEntries).toBe(0);

    // Mutating returned result warnings never corrupts cached entries.
    firstPoll.warnings.push('footnotes_skipped');
    const secondPoll = (await handleSignDocxConvertPoll({
      runtime,
      store,
      user,
      orgId,
      jobId: uploaded.jobId,
    })) as SignDocxConvertCompletedResult;
    expect(secondPoll.warnings).toEqual(['images_skipped']);

    // Failed poll also removes cached filename entry.
    const failUpload = await handleSignDocxConvertUpload({
      runtime,
      store,
      user,
      orgId,
      req: makeUploadRequest('tracked.docx'),
      waitMs: 0,
    });
    if (failUpload.status !== 'pending') throw new Error('expected pending');
    expect(getSignDocxRuntimeStats(runtime)?.filenameEntries).toBe(1);
    statuses.set(failUpload.jobId, {
      status: 'failed',
      jobId: failUpload.jobId,
      inputSha256: VALID_DOCX_SHA,
      inputStorageKey: `tmp/${orgId}/${VALID_DOCX_SHA}`,
      pdfSha256: null,
      pdfStorageKey: null,
      pdfSizeBytes: null,
      pageCount: null,
      warnings: [],
      errorCode: 'SIGN_DOCX_TRACK_CHANGES',
    });
    await expect(
      handleSignDocxConvertPoll({ runtime, store, user, orgId, jobId: failUpload.jobId }),
    ).rejects.toMatchObject({ code: 'SIGN_DOCX_TRACK_CHANGES', status: 422 });
    expect(getSignDocxRuntimeStats(runtime)?.filenameEntries).toBe(0);

    // Fill finalized cache past SIGN_DOCX_FINALIZED_MAX_ENTRIES (256) and verify LRU keeps hot jobId #1.
    const jobIds: string[] = [uploaded.jobId];
    const extraToFill = SIGN_DOCX_FINALIZED_MAX_ENTRIES - 1;
    for (let i = 0; i < extraToFill; i++) {
      const id = randomUUID();
      jobIds.push(id);
      addCompletedJob(id);
      await handleSignDocxConvertPoll({ runtime, store, user, orgId, jobId: id });
    }
    expect(getSignDocxRuntimeStats(runtime)?.finalizedEntries).toBe(SIGN_DOCX_FINALIZED_MAX_ENTRIES);

    // Touch uploaded.jobId so jobIds[1] becomes oldest, then insert one more -> jobIds[1] evicted, uploaded.jobId kept.
    const ingestsBeforeTouch = ingestSeq;
    await handleSignDocxConvertPoll({ runtime, store, user, orgId, jobId: uploaded.jobId });
    expect(ingestSeq).toBe(ingestsBeforeTouch);

    const overflowJobId = randomUUID();
    addCompletedJob(overflowJobId);
    await handleSignDocxConvertPoll({ runtime, store, user, orgId, jobId: overflowJobId });
    expect(getSignDocxRuntimeStats(runtime)?.finalizedEntries).toBe(SIGN_DOCX_FINALIZED_MAX_ENTRIES);

    const ingestsAfterOverflow = ingestSeq;
    await handleSignDocxConvertPoll({ runtime, store, user, orgId, jobId: uploaded.jobId });
    expect(ingestSeq).toBe(ingestsAfterOverflow);

    await handleSignDocxConvertPoll({ runtime, store, user, orgId, jobId: jobIds[1]! });
    expect(ingestSeq).toBe(ingestsAfterOverflow + 1);

    // Advancing past SIGN_DOCX_FINALIZED_TTL_MS expires cached entries so re-poll re-ingests cleanly.
    vi.advanceTimersByTime(SIGN_DOCX_FINALIZED_TTL_MS + 1);
    const ingestsBeforeExpiry = ingestSeq;
    await handleSignDocxConvertPoll({ runtime, store, user, orgId, jobId: overflowJobId });
    expect(ingestSeq).toBe(ingestsBeforeExpiry + 1);
    expect(getSignDocxRuntimeStats(runtime)?.finalizedEntries).toBe(1);
  });

  it('caps concurrent inflight finalizations at SIGN_DOCX_INFLIGHT_MAX_ENTRIES with 503 UPLOAD_BUSY', async () => {
    const store = makeMemoryStore();
    const orgId = randomUUID();
    const user = makeUser();
    const pdfStorageKey = `tmp/${orgId}/${PDF_SHA}`;
    await store.put(pdfStorageKey, PDF_BYTES, 'application/pdf');

    let releaseIngest!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseIngest = resolve;
    });
    const runtime = {
      query: vi.fn(async (_name: string, input: { jobId: string }) => ({
        status: 'completed',
        jobId: input.jobId,
        inputSha256: VALID_DOCX_SHA,
        inputStorageKey: `tmp/${orgId}/${VALID_DOCX_SHA}`,
        pdfSha256: PDF_SHA,
        pdfStorageKey,
        pdfSizeBytes: PDF_BYTES.byteLength,
        pageCount: 1,
        warnings: [],
        errorCode: null,
      })),
      execute: vi.fn(async () => {
        await gate;
        return { fileId: randomUUID(), duplicate: false };
      }),
    } as unknown as Runtime;

    const pendingPolls: Array<Promise<unknown>> = [];
    const sharedJobId = randomUUID();
    // Two concurrent polls for the same jobId share one inflight work promise and occupy 1 slot.
    pendingPolls.push(handleSignDocxConvertPoll({ runtime, store, user, orgId, jobId: sharedJobId }));
    pendingPolls.push(handleSignDocxConvertPoll({ runtime, store, user, orgId, jobId: sharedJobId }));
    for (let i = 1; i < SIGN_DOCX_INFLIGHT_MAX_ENTRIES; i++) {
      pendingPolls.push(
        handleSignDocxConvertPoll({ runtime, store, user, orgId, jobId: randomUUID() }),
      );
    }
    // Wait a microtask tick so all 64 distinct jobs have registered in inflight.
    await new Promise((r) => setTimeout(r, 10));
    expect(getSignDocxRuntimeStats(runtime)?.inflightCount).toBe(SIGN_DOCX_INFLIGHT_MAX_ENTRIES);
    expect(runtime.execute).toHaveBeenCalledTimes(SIGN_DOCX_INFLIGHT_MAX_ENTRIES);

    await expect(
      handleSignDocxConvertPoll({ runtime, store, user, orgId, jobId: randomUUID() }),
    ).rejects.toMatchObject({ code: 'UPLOAD_BUSY', status: 503 });

    releaseIngest();
    await Promise.all(pendingPolls);
    expect(getSignDocxRuntimeStats(runtime)?.inflightCount).toBe(0);
  });
});

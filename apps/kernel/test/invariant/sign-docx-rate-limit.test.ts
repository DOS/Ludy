// SPDX-License-Identifier: AGPL-3.0-only
// Invariant suite (Decision 7): enforces eSign .docx upload per-user 429 rate limits BEFORE stream body reading
// or BlobStore writes, bounds active rate-limiter key tracking under burst traffic without overflow eviction bypass,
// and reclaims expired buckets once idle windows pass (#4729).
// Self-contained: no imports from outside test/invariant/ besides code under test.
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type BlobStore, type Runtime } from '@ludy/kernel-runtime';
import type { AuthUser } from '../../src/auth.ts';
import {
  SIGN_DOCX_PER_MINUTE,
  SIGN_DOCX_RATE_LIMIT_MAX_KEYS,
  getSignDocxRuntimeStats,
  handleSignDocxConvertUpload,
} from '../../src/sign-docx-http.ts';

function makeActor(userId = randomUUID()): AuthUser {
  return {
    userId,
    email: `${userId}@example.test`,
    name: 'User',
    aal: 'aal2',
    sessionId: randomUUID(),
    mfaAt: Math.floor(Date.now() / 1000),
  };
}

function makeMemoryStore() {
  const putCalls: string[] = [];
  const store: BlobStore = {
    put: async (key) => {
      putCalls.push(key);
      return key;
    },
    get: async () => new Uint8Array(0),
    delete: async () => {},
  };
  return { store, putCalls };
}

function makeCountingMultipartRequest() {
  let chunksRead = 0;
  const payload = new TextEncoder().encode(
    '-----inv\r\nContent-Disposition: form-data; name="file"; filename="doc.docx"\r\n\r\nPK\x03\x04\r\n-----inv--\r\n',
  );
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        chunksRead += 1;
        controller.enqueue(payload);
        controller.close();
      },
    },
    { highWaterMark: 0 },
  );
  const req = new Request('http://localhost/api/sign/convert-docx', {
    method: 'POST',
    headers: { 'content-type': 'multipart/form-data; boundary=---inv' },
    body: stream,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });
  return {
    req,
    getChunksRead: () => chunksRead,
  };
}

function makeJsonRejectRequest() {
  return new Request('http://localhost/api/sign/convert-docx', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  });
}

describe('eSign .docx upload rate-limit and burst capacity invariants (#4729)', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('refuses rate-limited actors 429 before reading body stream or writing BlobStore and refuses burst overflow past max keys', async () => {
    const EXPECTED_MAX_PER_MINUTE = 20;
    const EXPECTED_MAX_KEYS = 4_096;
    expect(SIGN_DOCX_PER_MINUTE).toBeLessThanOrEqual(EXPECTED_MAX_PER_MINUTE);
    expect(SIGN_DOCX_RATE_LIMIT_MAX_KEYS).toBeLessThanOrEqual(EXPECTED_MAX_KEYS);

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-26T00:00:00.000Z'));

    const { store, putCalls } = makeMemoryStore();
    const orgId = randomUUID();
    const runtime = {
      query: vi.fn(async (name: string) => {
        if (name === 'sign.docx_convert.authorize') return { ok: true };
        if (name === 'sign.docx_convert.status') return { status: 'pending', jobId: randomUUID() };
        throw new Error(`unexpected query: ${name}`);
      }),
      execute: vi.fn(async () => ({})),
    } as unknown as Runtime;

    const repeatActor = makeActor();
    for (let i = 0; i < SIGN_DOCX_PER_MINUTE; i++) {
      await expect(
        handleSignDocxConvertUpload({
          runtime,
          store,
          user: repeatActor,
          orgId,
          req: makeJsonRejectRequest(),
          waitMs: 0,
        }),
      ).rejects.toMatchObject({ code: 'INVALID', status: 400 });
    }
    const putsBeforeLimit = putCalls.length;
    expect(putsBeforeLimit).toBe(0);

    // Actor past SIGN_DOCX_PER_MINUTE gets 429 BEFORE reading request body chunks or touching BlobStore.
    const limitedReq = makeCountingMultipartRequest();
    let retryAfterSec = 0;
    await expect(
      handleSignDocxConvertUpload({
        runtime,
        store,
        user: repeatActor,
        orgId,
        req: limitedReq.req,
        waitMs: 0,
        onRateLimited: (sec) => {
          retryAfterSec = sec;
        },
      }),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED', status: 429 });
    expect(retryAfterSec).toBeGreaterThanOrEqual(1);
    expect(limitedReq.getChunksRead()).toBe(0);
    expect(limitedReq.req.bodyUsed).toBe(false);
    expect(putCalls.length).toBe(putsBeforeLimit);

    // Distinct-user flood stays strictly bounded at SIGN_DOCX_RATE_LIMIT_MAX_KEYS without evicting live buckets or bypassing 429.
    for (let i = 1; i < SIGN_DOCX_RATE_LIMIT_MAX_KEYS; i++) {
      await expect(
        handleSignDocxConvertUpload({
          runtime,
          store,
          user: makeActor(),
          orgId,
          req: makeJsonRejectRequest(),
          waitMs: 0,
        }),
      ).rejects.toMatchObject({ code: 'INVALID', status: 400 });
    }
    expect(getSignDocxRuntimeStats(runtime)?.rateLimiterKeys).toBe(SIGN_DOCX_RATE_LIMIT_MAX_KEYS);

    const overflowReq = makeCountingMultipartRequest();
    await expect(
      handleSignDocxConvertUpload({
        runtime,
        store,
        user: makeActor(),
        orgId,
        req: overflowReq.req,
        waitMs: 0,
      }),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED', status: 429 });
    expect(overflowReq.getChunksRead()).toBe(0);
    expect(overflowReq.req.bodyUsed).toBe(false);
    expect(getSignDocxRuntimeStats(runtime)?.rateLimiterKeys).toBe(SIGN_DOCX_RATE_LIMIT_MAX_KEYS);
    expect(putCalls.length).toBe(putsBeforeLimit);

    // After the 1-minute window passes, expired buckets are swept and new uploads succeed cleanly.
    vi.advanceTimersByTime(61_000);
    await expect(
      handleSignDocxConvertUpload({
        runtime,
        store,
        user: makeActor(),
        orgId,
        req: makeJsonRejectRequest(),
        waitMs: 0,
      }),
    ).rejects.toMatchObject({ code: 'INVALID', status: 400 });
    expect(getSignDocxRuntimeStats(runtime)?.rateLimiterKeys).toBeLessThanOrEqual(1);
  });
});

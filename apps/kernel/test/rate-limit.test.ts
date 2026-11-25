// The per-user request limit at the HTTP edge (issue #162): the token bucket, its configuration and the 429 answer.
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import type { Db } from '@ludy/db';
import { DEFAULT_REFUSAL_AUDIT_LIMITS, DomainError, Runtime, type BlobStore } from '@ludy/kernel-runtime';
import type { AuthUser } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { RateLimiter } from '../src/rate-limit.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const base = { DATABASE_URL: 'postgres://localhost/x', AUTH_JWT_SECRET: 'x'.repeat(32), AUTH_ISSUER: 'ludy-auth', WEB_DIST: '/nonexistent' };

function clock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

describe('RateLimiter', () => {
  it('gives back a token a take spent, never past a full bucket, and does nothing for a key it does not know (#2965)', () => {
    const time = clock();
    const limiter = new RateLimiter({ perMinute: 2, now: time.now });
    expect(limiter.take('a').allowed).toBe(true);
    expect(limiter.take('a').allowed).toBe(true);
    expect(limiter.take('a').allowed).toBe(false);
    limiter.refund('a');
    expect(limiter.take('a').allowed).toBe(true);
    expect(limiter.take('a').allowed).toBe(false);
    // A refund never lifts a bucket above its size.
    time.advance(120_000);
    limiter.refund('a');
    limiter.refund('a');
    limiter.refund('a');
    expect([1, 2, 3].map(() => limiter.take('a').allowed)).toEqual([true, true, false]);
    limiter.refund('never-seen');
    expect(limiter.size).toBe(1);
  });

  it('allows perMinute requests at once, then refuses with the seconds until the next one', () => {
    const time = clock();
    const limiter = new RateLimiter({ perMinute: 3, now: time.now });
    expect([1, 2, 3].map(() => limiter.take('a').allowed)).toEqual([true, true, true]);
    // One request back every 20 seconds.
    expect(limiter.take('a')).toEqual({ allowed: false, retryAfterSeconds: 20 });
    time.advance(15_000);
    expect(limiter.take('a')).toEqual({ allowed: false, retryAfterSeconds: 5 });
    time.advance(5_000);
    expect(limiter.take('a').allowed).toBe(true);
    expect(limiter.take('a').allowed).toBe(false);
  });

  it('peeks without spending or tracking: unknown keys pass, an empty bucket answers like take (issue #281)', () => {
    const time = clock();
    const limiter = new RateLimiter({ perMinute: 2, now: time.now });
    expect(limiter.peek('a')).toEqual({ allowed: true, retryAfterSeconds: 0 });
    expect(limiter.size).toBe(0);
    limiter.take('a');
    expect(limiter.peek('a').allowed).toBe(true);
    limiter.take('a');
    expect(limiter.peek('a')).toEqual({ allowed: false, retryAfterSeconds: 30 });
    expect(limiter.peek('a')).toEqual({ allowed: false, retryAfterSeconds: 30 });
    time.advance(30_000);
    expect(limiter.peek('a').allowed).toBe(true);
    expect(limiter.take('a').allowed).toBe(true);
    expect(limiter.peek('a').allowed).toBe(false);
  });

  it('keeps each key on its own bucket', () => {
    const limiter = new RateLimiter({ perMinute: 1, now: clock().now });
    expect(limiter.take('a').allowed).toBe(true);
    expect(limiter.take('a').allowed).toBe(false);
    expect(limiter.take('b').allowed).toBe(true);
  });

  it('refills to the limit and no further, and a clock that goes back refills nothing', () => {
    const time = clock();
    const limiter = new RateLimiter({ perMinute: 2, now: time.now });
    limiter.take('a');
    limiter.take('a');
    time.advance(-60_000);
    expect(limiter.take('a').allowed).toBe(false);
    time.advance(10 * 60_000);
    expect([1, 2, 3].map(() => limiter.take('a').allowed)).toEqual([true, true, false]);
  });

  it('keeps at most maxKeys keys, dropping only buckets that are full again', () => {
    const time = clock();
    const limiter = new RateLimiter({ perMinute: 2, maxKeys: 3, now: time.now });
    for (const key of ['a', 'b', 'c']) limiter.take(key);
    // Every tracked bucket is still spending: a new key is refused, nobody's bucket is reset.
    expect(limiter.take('new')).toEqual({ allowed: false, retryAfterSeconds: 30 });
    expect(limiter.size).toBe(3);
    // Refused again without another sweep until a bucket can be full again.
    time.advance(10_000);
    expect(limiter.take('other')).toEqual({ allowed: false, retryAfterSeconds: 20 });
    // Known keys keep their own budget meanwhile.
    expect(limiter.take('a').allowed).toBe(true);
    expect(limiter.take('a').allowed).toBe(false);
    // Once b and c are full again they make room; a, still spending, is kept.
    time.advance(20_000);
    expect(limiter.take('new').allowed).toBe(true);
    expect(limiter.size).toBe(2);
    // a kept its own bucket (one token earned back since), not a fresh one with two.
    expect(limiter.take('a').allowed).toBe(true);
    expect(limiter.take('a').allowed).toBe(false);
  });

  it('refuses a limit that is not a positive integer', () => {
    for (const perMinute of [0, -1, 1.5, Number.NaN]) expect(() => new RateLimiter({ perMinute })).toThrow(/perMinute/);
  });
});

describe('rate limit and refusal audit configuration', () => {
  it('defaults to 600 requests per minute and the refusal audit bound of the runtime', () => {
    expect(loadConfig(base)).toMatchObject({
      API_RATE_LIMIT_PER_MINUTE: 600,
      REFUSAL_AUDIT_LIMIT_PER_ACTOR: DEFAULT_REFUSAL_AUDIT_LIMITS.perActor,
      REFUSAL_AUDIT_LIMIT_PER_ORG: DEFAULT_REFUSAL_AUDIT_LIMITS.perOrg,
      REFUSAL_AUDIT_WINDOW_SECONDS: DEFAULT_REFUSAL_AUDIT_LIMITS.windowSeconds,
    });
    expect(DEFAULT_REFUSAL_AUDIT_LIMITS).toEqual({ perActor: 50, perOrg: 500, windowSeconds: 3600, reserve: 10 });
    expect(loadConfig(base)).toMatchObject({ REFUSAL_AUDIT_RESERVE_PER_ACTOR: 10, REFUSAL_TALLY_RETENTION_DAYS: 7 });
    expect(loadConfig({ ...base, API_RATE_LIMIT_PER_MINUTE: '0' }).API_RATE_LIMIT_PER_MINUTE).toBe(0);
  });

  it('refuses malformed values instead of ignoring them', () => {
    for (const value of ['-1', '1.5', 'many', '1000000']) {
      expect(() => loadConfig({ ...base, API_RATE_LIMIT_PER_MINUTE: value })).toThrow(/API_RATE_LIMIT_PER_MINUTE/);
    }
    for (const field of ['REFUSAL_AUDIT_LIMIT_PER_ACTOR', 'REFUSAL_AUDIT_LIMIT_PER_ORG']) {
      for (const value of ['0', '-1', '1.5', 'many', '1000000']) expect(() => loadConfig({ ...base, [field]: value })).toThrow(new RegExp(field));
    }
    for (const value of ['-1', '1.5', 'many']) expect(() => loadConfig({ ...base, REFUSAL_AUDIT_RESERVE_PER_ACTOR: value })).toThrow(/REFUSAL_AUDIT_RESERVE_PER_ACTOR/);
    expect(() => loadConfig({ ...base, REFUSAL_AUDIT_LIMIT_PER_ACTOR: '5', REFUSAL_AUDIT_RESERVE_PER_ACTOR: '6' })).toThrow(/RESERVE/);
    expect(loadConfig({ ...base, REFUSAL_AUDIT_RESERVE_PER_ACTOR: '0' }).REFUSAL_AUDIT_RESERVE_PER_ACTOR).toBe(0);
    for (const value of ['0', '3651', 'week']) expect(() => loadConfig({ ...base, REFUSAL_TALLY_RETENTION_DAYS: value })).toThrow(/REFUSAL_TALLY_RETENTION_DAYS/);
    for (const value of ['59', '86401', '0', 'hour']) {
      expect(() => loadConfig({ ...base, REFUSAL_AUDIT_WINDOW_SECONDS: value })).toThrow(/REFUSAL_AUDIT_WINDOW_SECONDS/);
    }
  });

  it('refuses refusal audit limits out of range in the runtime too', () => {
    const db = {} as Db;
    expect(() => new Runtime(db, { manifests: TEST_MANIFESTS, refusalAudit: { perActor: 0, perOrg: 1, windowSeconds: 60 } })).toThrow(/perActor/);
    expect(() => new Runtime(db, { manifests: TEST_MANIFESTS, refusalAudit: { perActor: 1, perOrg: 1_000_000, windowSeconds: 60 } })).toThrow(/perOrg/);
    expect(() => new Runtime(db, { manifests: TEST_MANIFESTS, refusalAudit: { perActor: 1, perOrg: 1, windowSeconds: 30 } })).toThrow(/windowSeconds/);
    expect(() => new Runtime(db, { manifests: TEST_MANIFESTS, refusalAudit: { perActor: 5, perOrg: 9, windowSeconds: 60, reserve: 6 } })).toThrow(/reserve/);
    expect(() => new Runtime(db, { manifests: TEST_MANIFESTS, refusalAudit: { perActor: 5, perOrg: 9, windowSeconds: 60, reserve: -1 } })).toThrow(/reserve/);
    expect(() => new Runtime(db, { manifests: TEST_MANIFESTS, refusalAudit: 'unbounded' })).not.toThrow();
  });
});

describe('per-user request limit on /api', () => {
  const users: Record<string, AuthUser> = {
    alice: { userId: 'alice', email: 'a@example.com', name: null, aal: 'aal1', sessionId: 's-a', mfaAt: null },
    bob: { userId: 'bob', email: 'b@example.com', name: null, aal: 'aal1', sessionId: 's-b', mfaAt: null },
  };
  const app = (options: { perMinute?: string; limiter?: RateLimiter | null }) => {
    let calls = 0;
    const built = createHttpApp({
      config: loadConfig({ ...base, ...(options.perMinute ? { API_RATE_LIMIT_PER_MINUTE: options.perMinute } : {}) }),
      runtime: { installed: () => true, modules: () => ['kernel', 'finance'] } as unknown as Runtime,
      store: {} as BlobStore,
      authenticate: async (header) => {
        calls++;
        const user = users[header?.replace('Bearer ', '') ?? ''];
        if (!user) throw new DomainError('UNAUTHENTICATED', 401, 'Phiên đăng nhập không hợp lệ');
        return user;
      },
      pool: {} as pg.Pool,
      aiEnabled: false,
      ...(options.limiter !== undefined ? { rateLimiter: options.limiter } : {}),
    });
    return { built, calls: () => calls };
  };
  // An unknown /api path answers 404 after the middleware, so it shows what the limit lets through.
  const get = (target: ReturnType<typeof app>, who: string) => target.built.request('/api/nothing-here', { headers: { authorization: `Bearer ${who}` } });

  it('answers 429 RATE_LIMITED with Retry-After past the limit, per user', async () => {
    const target = app({ perMinute: '2' });
    expect((await get(target, 'alice')).status).toBe(404);
    expect((await get(target, 'alice')).status).toBe(404);
    const refused = await get(target, 'alice');
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect(await refused.json()).toMatchObject({ code: 'RATE_LIMITED', retryAfterSeconds: expect.any(Number) });
    // Another user still gets through.
    expect((await get(target, 'bob')).status).toBe(404);
  });

  it('limits only after the token is verified, so a bad token cannot spend a user budget', async () => {
    const target = app({ perMinute: '1' });
    for (let i = 0; i < 5; i++) expect((await target.built.request('/api/nothing-here', { headers: { authorization: 'Bearer mallory' } })).status).toBe(401);
    expect((await get(target, 'alice')).status).toBe(404);
  });

  it('is off with API_RATE_LIMIT_PER_MINUTE=0 or a null limiter', async () => {
    for (const target of [app({ perMinute: '0' }), app({ perMinute: '1', limiter: null })]) {
      for (let i = 0; i < 5; i++) expect((await get(target, 'alice')).status).toBe(404);
    }
  });

  it('leaves the public endpoints alone', async () => {
    const target = app({ perMinute: '1' });
    for (let i = 0; i < 3; i++) expect((await target.built.request('/api/config')).status).toBe(200);
    expect(target.calls()).toBe(0);
  });
});

describe('per-extension-token write limit and fail-closed appOn edge (#3742)', () => {
  const orgId = '11111111-1111-4111-8111-111111111111';
  const meetingId = '22222222-2222-4222-8222-222222222222';
  const extUser = (tokenId: string, scopes: readonly ('meetings' | 'agenda' | 'notes')[]): AuthUser => ({
    userId: 'user-1',
    email: 'u@example.com',
    name: null,
    aal: 'aal1',
    sessionId: '',
    mfaAt: null,
    extension: { tokenId, orgId, userId: 'user-1', scopes: [...scopes], expiresAt: '2027-01-01T00:00:00.000Z' },
  });
  const browserUser: AuthUser = {
    userId: 'user-1',
    email: 'u@example.com',
    name: null,
    aal: 'aal1',
    sessionId: 'sess-1',
    mfaAt: null,
  };

  function makeApp(opts: {
    rateLimiter?: RateLimiter | null;
    extensionWriteLimit?: RateLimiter | null;
    installedImpl?: (mod: string) => boolean;
    appOnImpl?: (org: string, mod: string, options?: { fresh?: boolean }) => Promise<boolean>;
  }) {
    const usersByHeader: Record<string, AuthUser> = {
      'Bearer tokA': extUser('tok-a', ['meetings', 'agenda', 'notes']),
      'Bearer tokB': extUser('tok-b', ['meetings', 'agenda', 'notes']),
      'Bearer browser': browserUser,
    };
    const executeCalls: string[] = [];
    const queryCalls: string[] = [];
    const built = createHttpApp({
      config: loadConfig({ ...base, PUBLIC_URL: 'http://localhost:8080', EXTENSION_IDS: 'a'.repeat(32) }),
      runtime: {
        installed: opts.installedImpl ?? (() => true),
        modules: () => ['kernel', 'meetings', 'notes'],
        appOn: opts.appOnImpl ?? (async () => true),
        execute: async (cmd: string) => {
          executeCalls.push(cmd);
          return { expiresInSeconds: 300 };
        },
        query: async (q: string) => {
          queryCalls.push(q);
          return { enabled: false, events: [], keepVideo: false, liveNotes: false, isRecorder: true };
        },
        forUser: async (_actor: unknown, fn: unknown) => {
          if (typeof fn === 'function') return [{ orgId, slug: 'org-1', name: 'Org 1', role: 'owner' }];
          return [];
        },
      } as unknown as Runtime,
      store: {} as BlobStore,
      authenticate: async (header) => {
        const u = usersByHeader[header ?? ''];
        if (!u) throw new DomainError('UNAUTHENTICATED', 401, 'unauth');
        return u;
      },
      pool: {} as pg.Pool,
      aiEnabled: false,
      ...(opts.rateLimiter !== undefined ? { rateLimiter: opts.rateLimiter } : {}),
      ...(opts.extensionWriteLimit !== undefined ? { extensionWriteLimit: opts.extensionWriteLimit } : {}),
    });
    return { built, executeCalls, queryCalls };
  }

  it('caps extension bearer write routes per token with 429 and Retry-After while leaving reads and other tokens open', async () => {
    for (const rateLimiter of [undefined, null] as Array<undefined | null>) {
      const { built } = makeApp({
        ...(rateLimiter !== undefined ? { rateLimiter } : {}),
        extensionWriteLimit: new RateLimiter({ perMinute: 2 }),
      });
      const post = (path: string, bearer = 'tokA') =>
        built.request(path, {
          method: 'POST',
          headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
          body: '{}',
        });

      // Read routes do not consume the write budget.
      expect((await built.request('/api/extension/me', { headers: { authorization: 'Bearer tokA' } })).status).toBe(200);
      expect((await post('/api/rpc/meetings/extensionStatus')).status).not.toBe(429);
      expect((await post('/api/rpc/meetings/agenda/next')).status).not.toBe(429);

      // Two writes spend tokA's write budget (400/404 from stubbed RPC/store proves middleware passed them through).
      expect((await post('/api/rpc/notes/clip')).status).not.toBe(429);
      expect((await post('/api/rpc/notes/todos/quickCapture')).status).not.toBe(429);

      // Subsequent writes on all notes and meetings extension write routes are refused 429 with Retry-After.
      for (const writePath of [
        '/api/rpc/notes/clip',
        '/api/rpc/notes/todos/quickCapture',
        '/api/rpc/meetings/create',
        '/api/rpc/meetings/recordingStopped',
        '/api/rpc/meetings/captureHeartbeat',
        '/api/files/uploads',
        `/api/meetings/${meetingId}/media`,
        `/api/meetings/${meetingId}/live-chunk`,
      ]) {
        const limited = await post(writePath);
        expect(limited.status, writePath).toBe(429);
        expect(Number(limited.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
        expect(await limited.json()).toMatchObject({ code: 'RATE_LIMITED', retryAfterSeconds: expect.any(Number) });
      }

      // Read routes remain open for tokA even after its write cap is exhausted.
      expect((await built.request('/api/extension/me', { headers: { authorization: 'Bearer tokA' } })).status).toBe(200);
      expect((await post('/api/rpc/meetings/extensionStatus')).status).not.toBe(429);

      // Another token of the same user keeps its own write budget.
      expect((await post('/api/rpc/notes/clip', 'tokB')).status).not.toBe(429);
    }
  });

  it('allows extension writes without limit when extensionWriteLimit is explicitly null', async () => {
    const { built } = makeApp({ rateLimiter: null, extensionWriteLimit: null });
    for (let i = 0; i < 5; i += 1) {
      const res = await built.request('/api/rpc/notes/clip', {
        method: 'POST',
        headers: { authorization: 'Bearer tokA', 'content-type': 'application/json' },
        body: '{}',
      });
      expect(res.status).not.toBe(429);
    }
  });

  it('fails closed on transient runtime.appOn errors across /api/extension/authorize, /api/extension/me, and /api/files/uploads', async () => {
    const { built, executeCalls } = makeApp({
      rateLimiter: null,
      appOnImpl: async () => {
        throw new Error('transient db outage');
      },
    });

    const authNotes = await built.request('/api/extension/authorize', {
      method: 'POST',
      headers: { authorization: 'Bearer browser', 'content-type': 'application/json', 'x-ludy-org': 'org-1' },
      body: JSON.stringify({
        extensionId: 'a'.repeat(32),
        codeChallenge: 'A'.repeat(43),
        codeChallengeMethod: 'S256',
        scopes: ['notes'],
        deviceName: 'Chrome',
      }),
    });
    expect(authNotes.status).toBe(503);
    expect(await authNotes.json()).toMatchObject({ code: 'SERVICE_UNAVAILABLE' });

    const authMeetings = await built.request('/api/extension/authorize', {
      method: 'POST',
      headers: { authorization: 'Bearer browser', 'content-type': 'application/json', 'x-ludy-org': 'org-1' },
      body: JSON.stringify({
        extensionId: 'a'.repeat(32),
        codeChallenge: 'A'.repeat(43),
        codeChallengeMethod: 'S256',
        scopes: ['meetings'],
        deviceName: 'Chrome',
      }),
    });
    expect(authMeetings.status).toBe(503);
    expect(executeCalls).toEqual([]);

    const meRes = await built.request('/api/extension/me', {
      headers: { authorization: 'Bearer tokA' },
    });
    expect(meRes.status).toBe(503);
    expect(await meRes.json()).toMatchObject({ code: 'SERVICE_UNAVAILABLE' });

    const uploadRes = await built.request('/api/files', {
      method: 'POST',
      headers: { authorization: 'Bearer browser', 'x-ludy-org': 'org-1' },
      body: (() => {
        const f = new FormData();
        f.set('purpose', 'meeting_audio');
        return f;
      })(),
    });
    expect(uploadRes.status).toBe(503);
    expect(executeCalls).toEqual([]);
  });

  it('fails closed (503) on transient appOn errors across notes and HR browser routes while keeping 404/DomainError semantics (#4638)', async () => {
    const noteId = '33333333-3333-4333-8333-333333333333';
    const attId = '44444444-4444-4444-8444-444444444444';
    const jobId = '55555555-5555-4555-8555-555555555555';
    const browserHeaders = { authorization: 'Bearer browser', 'x-ludy-org': 'org-1' };

    const routes: Array<{ method: 'GET' | 'POST'; path: string; mod: 'notes' | 'hr' | 'sign'; offCode: string }> = [
      { method: 'POST', path: `/api/notes/${noteId}/attachments`, mod: 'notes', offCode: 'NOT_FOUND' },
      { method: 'GET', path: `/api/notes/attachments/${attId}`, mod: 'notes', offCode: 'NOTE_ATTACHMENT_NOT_FOUND' },
      { method: 'POST', path: '/api/notes/import/enex', mod: 'notes', offCode: 'NOT_FOUND' },
      { method: 'POST', path: '/api/notes/import/todoist', mod: 'notes', offCode: 'NOT_FOUND' },
      { method: 'POST', path: '/api/hr/recruiting/cv-extract', mod: 'hr', offCode: 'NOT_FOUND' },
      { method: 'GET', path: `/api/hr/recruiting/cv-extract/${jobId}`, mod: 'hr', offCode: 'NOT_FOUND' },
      { method: 'POST', path: '/api/sign/convert-docx', mod: 'sign', offCode: 'NOT_FOUND' },
      { method: 'GET', path: `/api/sign/convert-docx/${jobId}`, mod: 'sign', offCode: 'NOT_FOUND' },
    ];

    const sendRoute = (target: ReturnType<typeof createHttpApp>, r: (typeof routes)[number]) =>
      target.request(r.path, {
        method: r.method,
        headers: browserHeaders,
        ...(r.method === 'POST' ? { body: new FormData() } : {}),
      });

    // 1. Transient appOn errors fail closed with 503 SERVICE_UNAVAILABLE before any query/execute runs.
    const seenFresh: Array<{ org: string; mod: string; fresh: boolean | undefined }> = [];
    const transientOutage = makeApp({
      rateLimiter: null,
      appOnImpl: async (org, mod, options) => {
        seenFresh.push({ org, mod, fresh: options?.fresh });
        throw new Error('transient db outage');
      },
    });
    for (const r of routes) {
      const res = await sendRoute(transientOutage.built, r);
      expect(res.status, `${r.method} ${r.path}`).toBe(503);
      expect(await res.json(), `${r.method} ${r.path}`).toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    }
    expect(seenFresh).toEqual(routes.map((r) => ({ org: orgId, mod: r.mod, fresh: true })));
    expect(transientOutage.executeCalls).toEqual([]);
    expect(transientOutage.queryCalls).toEqual([]);

    // 2. DomainError from appOn is propagated directly rather than masked as 503.
    const domainErrorApp = makeApp({
      rateLimiter: null,
      appOnImpl: async () => {
        throw new DomainError('FORBIDDEN', 403, 'denied');
      },
    });
    for (const r of routes) {
      const res = await sendRoute(domainErrorApp.built, r);
      expect(res.status, `${r.method} ${r.path}`).toBe(403);
      expect(await res.json()).toMatchObject({ code: 'FORBIDDEN' });
    }

    // 3. Disabled app (appOn -> false) keeps route-specific 404 semantics.
    const appOff = makeApp({
      rateLimiter: null,
      appOnImpl: async () => false,
    });
    for (const r of routes) {
      const res = await sendRoute(appOff.built, r);
      expect(res.status, `${r.method} ${r.path}`).toBe(404);
      expect(await res.json()).toMatchObject({ code: r.offCode });
    }

    // 4. Uninstalled deployment module keeps 404 without calling appOn.
    let appOnCalled = 0;
    const uninstalled = makeApp({
      rateLimiter: null,
      installedImpl: () => false,
      appOnImpl: async () => {
        appOnCalled += 1;
        throw new Error('should not be called');
      },
    });
    for (const r of routes) {
      const res = await sendRoute(uninstalled.built, r);
      expect(res.status, `${r.method} ${r.path}`).toBe(404);
      expect(await res.json()).toMatchObject({ code: r.offCode });
    }
    expect(appOnCalled).toBe(0);
  });
});

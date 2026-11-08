// SPDX-License-Identifier: AGPL-3.0-only
// POST /api/quote/logo (#2814, docs/plan/crm-quotes.md section 4.6), the public route the quote page asks for the letterhead's logo by the link's token, with a stand-in runtime and
// store: every bad case (an unknown or revoked link, a malformed token or body, a quote with no logo, bytes that are not the type the row says) is the one same 404; a good one serves
// the bytes with the headers that keep an image an image (type from the verified row, nosniff, no-store, a CSP that allows nothing, no referrer); each client has its own small
// budget; and a deployment without the CRM module has no such route. The link and the logo's own rules (revoked, expired, replaced, another org) are the definer's, proved in
// crm-quote-send.db.test.ts on PostgreSQL.
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { sha256Hex, type BlobStore, type Runtime } from '@crove/kernel-runtime';
import type { AuthUser } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { ConcurrencyLimiter } from '../src/concurrency.ts';
import { RateLimiter } from '../src/rate-limit.ts';

const config = loadConfig({ DATABASE_URL: 'postgres://localhost/x', AUTH_JWT_SECRET: 'x'.repeat(32), AUTH_ISSUER: 'crove-auth', WEB_DIST: '/nonexistent', BRAND_NAME: 'Ludy' });
const user: AuthUser = { userId: randomUUID(), email: 'a@example.com', name: null, aal: 'aal1', sessionId: randomUUID(), mfaAt: null };
const TOKEN = 'q'.repeat(43);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1]);
const INVALID = { code: 'QUOTE_LINK_INVALID', message: 'Liên kết báo giá không hợp lệ, đã bị thu hồi hoặc đã hết hạn' };

const ref = (bytes: Uint8Array, contentType = 'image/png') => ({ storageKey: 'org/logo', generation: null, sha256: sha256Hex(bytes), contentType, sizeBytes: bytes.byteLength });

// `found` is what the definer answers for the token: null for every refusal it has, else the logo's reference.
function appWith(options: { crm?: boolean; found?: ReturnType<typeof ref> | null; stored?: Uint8Array; perMinute?: number; get?: () => Promise<Uint8Array>; reads?: ConcurrencyLimiter } = {}) {
  const runtime = {
    installed: (module: string) => (module === 'crm' ? (options.crm ?? true) : true),
    modules: () => ['kernel', 'crm'],
    orgless: async () => options.found ?? null,
  } as unknown as Runtime;
  const store = { put: async () => '', get: options.get ?? (async () => options.stored ?? PNG), delete: async () => undefined } as unknown as BlobStore;
  return createHttpApp({
    config,
    runtime,
    store,
    authenticate: async () => user,
    pool: {} as pg.Pool,
    aiEnabled: false,
    quoteLogoLimit: new RateLimiter({ perMinute: options.perMinute ?? 100 }),
    ...(options.reads ? { quoteLogoReads: options.reads } : {}),
  });
}

const post = (app: ReturnType<typeof appWith>, body: string | null, contentType = 'application/json') =>
  app.request('/api/quote/logo', { method: 'POST', headers: { 'content-type': contentType }, ...(body === null ? {} : { body }) });

describe('POST /api/quote/logo (#2814)', () => {
  it('answers the one same 404 for every bad case: no live link or no logo, a malformed token, a malformed body, bytes that are not what the row says', async () => {
    const cases: Array<[string, ReturnType<typeof appWith>, string | null]> = [
      ['an unknown, revoked, expired or replaced link, or a quote with no logo (the definer answers nothing)', appWith({ found: null }), JSON.stringify({ token: TOKEN })],
      ['a token that is too short', appWith({ found: ref(PNG) }), JSON.stringify({ token: 'abc' })],
      ['a token with a character the alphabet does not have', appWith({ found: ref(PNG) }), JSON.stringify({ token: `${'q'.repeat(42)}!` })],
      ['a body that is not JSON', appWith({ found: ref(PNG) }), 'not json at all'],
      ['no body', appWith({ found: ref(PNG) }), null],
      ['a body with more than the token', appWith({ found: ref(PNG) }), JSON.stringify({ token: TOKEN, orgId: randomUUID() })],
      ['bytes that are a JPEG where the row says PNG', appWith({ found: ref(JPEG, 'image/png'), stored: JPEG }), JSON.stringify({ token: TOKEN })],
      ['a row that says WebP', appWith({ found: ref(PNG, 'image/webp') }), JSON.stringify({ token: TOKEN })],
      ['a row that says SVG', appWith({ found: ref(PNG, 'image/svg+xml') }), JSON.stringify({ token: TOKEN })],
      ['a file the row says is larger than a logo may be', appWith({ found: { ...ref(PNG), sizeBytes: 512 * 1024 + 1 } }), JSON.stringify({ token: TOKEN })],
    ];
    for (const [label, app, body] of cases) {
      const response = await post(app, body);
      expect(response.status, label).toBe(404);
      expect(await response.json(), label).toEqual(INVALID);
      expect(response.headers.get('cache-control'), label).toBe('no-store');
      expect(response.headers.get('content-type') ?? '', label).not.toMatch(/image/);
    }
  });

  it('serves the bytes with the type of the verified row and headers that keep them an image: no-store, nosniff, a CSP that allows nothing, no referrer', async () => {
    for (const [bytes, type] of [[PNG, 'image/png'], [JPEG, 'image/jpeg']] as const) {
      const response = await post(appWith({ found: ref(bytes, type), stored: bytes }), JSON.stringify({ token: TOKEN }));
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe(type);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(response.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
      expect(response.headers.get('referrer-policy')).toBe('no-referrer');
      expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([...bytes]);
    }
  });

  it('gives each client a small budget and tells the one over it to wait', async () => {
    const app = appWith({ found: ref(PNG), perMinute: 2 });
    expect((await post(app, JSON.stringify({ token: TOKEN }))).status).toBe(200);
    expect((await post(app, JSON.stringify({ token: 'abc' }))).status).toBe(404);
    const refused = await post(app, JSON.stringify({ token: TOKEN }));
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(await refused.json()).toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('caps the logo reads in flight for the whole process: one over the cap gets 503 with retry-after, and the slot is free again when a read ends', async () => {
    let open: (bytes: Uint8Array) => void = () => undefined;
    const reads = new ConcurrencyLimiter({ total: 1, perKey: 1 });
    const app = appWith({ found: ref(PNG), reads, get: () => new Promise<Uint8Array>((resolve) => { open = resolve; }) });
    const first = post(app, JSON.stringify({ token: TOKEN }));
    await vi.waitFor(() => expect(reads.inUse).toBe(1));
    const busy = await post(app, JSON.stringify({ token: TOKEN }));
    expect(busy.status).toBe(503);
    expect(Number(busy.headers.get('retry-after'))).toBeGreaterThan(0);
    open(PNG);
    expect((await first).status).toBe(200);
    expect(reads.inUse).toBe(0);
  });

  it('is not there without the CRM module, and takes no GET', async () => {
    expect((await post(appWith({ crm: false, found: ref(PNG) }), JSON.stringify({ token: TOKEN }))).status).toBe(404);
    expect((await appWith({ found: ref(PNG) }).request('/api/quote/logo', { method: 'GET' })).status).toBeGreaterThanOrEqual(404);
  });
});

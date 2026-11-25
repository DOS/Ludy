// SPDX-License-Identifier: AGPL-3.0-only
// Invariant suite (Decision 7): POST /webhooks/mail/:provider checks unknown provider (404) and reserves a per-IP
// refusal token atomically before bodyLimit reads chunked bodies, refunding on verified deliveries and 503 capacity (#4960).
// Self-contained: no imports from outside test/invariant/ besides app/package code under test.
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import type { BlobStore, Runtime } from '@ludy/kernel-runtime';
import { WebhookRejected, type MailProvider } from '@ludy/mail';
import { loadConfig } from '../../src/config.ts';
import { createHttpApp } from '../../src/http.ts';
import { RateLimiter } from '../../src/rate-limit.ts';

function buildApp(options: { perMinute: number; mailer: MailProvider }) {
  const runtime = {
    installed: () => true,
    modules: () => ['kernel'],
    orgless: async () => 1,
  } as unknown as Runtime;
  const config = loadConfig({ DATABASE_URL: 'postgres://localhost/x', AUTH_JWT_SECRET: 'x'.repeat(32), AUTH_ISSUER: 'ludy-auth', WEB_DIST: '/nonexistent' });
  return createHttpApp({
    config,
    runtime,
    store: {} as BlobStore,
    authenticate: (async () => {
      throw new Error('mail webhook must never call authenticate');
    }) as never,
    pool: {} as pg.Pool,
    aiEnabled: false,
    mailer: options.mailer,
    mailWebhookLimit: new RateLimiter({ perMinute: options.perMinute }),
  });
}

describe('mail webhook route pre-body rate limit and ordering invariants (#4960)', () => {
  it('refuses a chunked body from a rate-limited address before bodyLimit pulls past the first chunk', async () => {
    let parseCalls = 0;
    const http = buildApp({
      perMinute: 1,
      mailer: {
        name: 'ses',
        enabled: true,
        sendRetrySafety: 'never',
        send: async () => ({ status: 'accepted' }),
        parseWebhook: async () => {
          parseCalls += 1;
          throw new WebhookRejected('signature');
        },
      },
    });
    expect((await http.request('/webhooks/mail/ses', { method: 'POST', body: '{}' })).status).toBe(401);
    expect(parseCalls).toBe(1);

    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new TextEncoder().encode('x'.repeat(1024)));
        if (pulled > 3) controller.close();
      },
    });
    const limited = await http.request('/webhooks/mail/ses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: stream,
      duplex: 'half',
    } as RequestInit);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect(pulled).toBeLessThanOrEqual(1);
    expect(parseCalls).toBe(1);
  });

  it('answers unknown providers 404 without spending a token and refunds on 200/202 and 503 capacity', async () => {
    let parseCalls = 0;
    const http = buildApp({
      perMinute: 1,
      mailer: {
        name: 'ses',
        enabled: true,
        sendRetrySafety: 'never',
        send: async () => ({ status: 'accepted' }),
        parseWebhook: async (req) => {
          parseCalls += 1;
          if (req.headers['x-mode'] === 'capacity') throw new WebhookRejected('capacity');
          if (req.headers['x-mode'] === 'bad') throw new WebhookRejected('signature');
          if (req.headers['x-mode'] === 'event') {
            return [{ providerEventId: 'e1', providerMessageId: 'm1', kind: 'delivered', occurredAt: '2026-11-25T12:00:00.000Z', detail: {} }];
          }
          return [];
        },
      },
    });

    // Wrong providers return 404 before rate limiting or body parsing.
    for (let i = 0; i < 3; i++) {
      expect((await http.request('/webhooks/mail/resend', { method: 'POST', body: '{}' })).status).toBe(404);
    }
    expect(parseCalls).toBe(0);

    // 200 and 202 verified responses plus 503 capacity responses refund their reserved token.
    for (let i = 0; i < 3; i++) {
      expect((await http.request('/webhooks/mail/ses', { method: 'POST', body: '{}' })).status).toBe(200);
      expect((await http.request('/webhooks/mail/ses', { method: 'POST', headers: { 'x-mode': 'event' }, body: '{}' })).status).toBe(202);
      const cap = await http.request('/webhooks/mail/ses', { method: 'POST', headers: { 'x-mode': 'capacity' }, body: '{}' });
      expect(cap.status).toBe(503);
      expect(cap.headers.get('retry-after')).toBe('5');
      expect(await cap.json()).toEqual({ code: 'WEBHOOK_CAPACITY' });
    }
    expect(parseCalls).toBe(9);

    // First invalid probe spends the single remaining token; next invalid probe gets 429.
    expect((await http.request('/webhooks/mail/ses', { method: 'POST', headers: { 'x-mode': 'bad' }, body: '{}' })).status).toBe(401);
    expect((await http.request('/webhooks/mail/ses', { method: 'POST', headers: { 'x-mode': 'bad' }, body: '{}' })).status).toBe(429);
    expect(parseCalls).toBe(10);
  });

  it('prevents concurrent invalid bursts from bypassing the pre-body limit during async verification', async () => {
    let parseCalls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const http = buildApp({
      perMinute: 1,
      mailer: {
        name: 'ses',
        enabled: true,
        sendRetrySafety: 'never',
        send: async () => ({ status: 'accepted' }),
        parseWebhook: async () => {
          parseCalls += 1;
          await gate;
          throw new WebhookRejected('signature');
        },
      },
    });

    const p1 = http.request('/webhooks/mail/ses', { method: 'POST', body: '{}' });
    const p2 = http.request('/webhooks/mail/ses', { method: 'POST', body: '{}' });
    const p3 = http.request('/webhooks/mail/ses', { method: 'POST', body: '{}' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    release();
    const statuses = (await Promise.all([p1, p2, p3])).map((r) => r.status);
    expect(statuses.sort()).toEqual([401, 429, 429]);
    expect(parseCalls).toBe(1);
  });
});

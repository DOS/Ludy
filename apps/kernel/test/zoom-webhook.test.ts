// SPDX-License-Identifier: AGPL-3.0-only
// Zoom's signed webhook through the real HTTP app, without a database (meetings integrations C3, #3175): the route exists only with the secret token and the Meetings module, a verified recording notice
// only rings the sweep (one call of the definer with the provider and the host id), every refusal is the same answer and calls nothing, the challenge is no signing oracle, the rate limit is charged to
// refusals and unsigned challenges only, and nothing of a body reaches a log. The runtime is a fake that records the SQL the route runs; the definer itself is tested on a real database in
// meeting-platform-ring.db.test.ts.
import { createHmac } from 'node:crypto';
import { DummyDriver, Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler } from 'kysely';
import type pg from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BlobStore, Runtime } from '@ludy/kernel-runtime';
import { loadConfig } from '../src/config.ts';
import { createHttpApp, type HttpDeps } from '../src/http.ts';
import { RateLimiter } from '../src/rate-limit.ts';
import { ZOOM_REPLAY_WINDOW_MS, ZOOM_WEBHOOK_PATH, ZoomReplayCache } from '../src/zoom-webhook.ts';

const SECRET = 'zoom-secret-token-not-real-0001';
const PREVIOUS = 'zoom-secret-token-old-not-real-0002';
const NOW = Date.parse('2026-11-18T12:00:00Z');
const TS = String(Math.floor(NOW / 1000));
const HOST = 'KdYKjnimT4KPd8FFgQt9FQ';
const recording = (over: Record<string, unknown> = {}) => JSON.stringify({ event: 'recording.completed', event_ts: 1731931200000, payload: { account_id: 'acc', object: { uuid: 'uuid-1', host_id: HOST, topic: 'Họp khách A', download_token: 'download-token-not-real' } }, ...over });
const sign = (text: string, timestamp = TS, secret = SECRET) => `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${text}`).digest('hex')}`;

function fakeRuntime(installed: readonly string[] = ['kernel', 'meetings']) {
  const calls: { sql: string; parameters: readonly unknown[] }[] = [];
  const db = new Kysely<unknown>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (k) => new PostgresIntrospector(k),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
    log: (event) => {
      if (event.level === 'query') calls.push({ sql: event.query.sql, parameters: event.query.parameters });
    },
  });
  const runtime = { installed: (name: string) => installed.includes(name), modules: () => [...installed], orgless: async (fn: (d: Kysely<unknown>) => Promise<unknown>) => fn(db) } as unknown as Runtime;
  return { calls, runtime };
}

const config = loadConfig({ DATABASE_URL: 'postgres://localhost/x', AUTH_JWT_SECRET: 'x'.repeat(32), AUTH_ISSUER: 'crove-auth', WEB_DIST: '/nonexistent' });
function app(over: Partial<HttpDeps> = {}, installed?: readonly string[]) {
  const { calls, runtime } = fakeRuntime(installed);
  const authenticate = vi.fn(async () => {
    throw new Error('the webhook must not authenticate a user');
  });
  const http = createHttpApp({ config, runtime, store: {} as BlobStore, authenticate: authenticate as never, pool: {} as pg.Pool, aiEnabled: false, zoomWebhook: { secretToken: SECRET, secretTokenPrevious: PREVIOUS, now: () => NOW }, ...over });
  const post = (text: string, headers: Record<string, string> = {}) => http.request(ZOOM_WEBHOOK_PATH, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: text });
  const signed = (text: string, timestamp = TS, secret = SECRET) => post(text, { 'x-zm-signature': sign(text, timestamp, secret), 'x-zm-request-timestamp': timestamp });
  return { http, calls, post, signed, authenticate };
}
const bodyOf = async (response: Response) => (await response.json()) as Record<string, unknown>;

let logs: string[] = [];
beforeEach(() => {
  logs = [];
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logs.push(args.map(String).join(' ')));
});
afterEach(() => vi.restoreAllMocks());

describe('the Zoom webhook route', () => {
  it('exists only with the secret token and the Meetings module, and is never behind a user session', async () => {
    // Left out of the deps, as kernel.ts does without ZOOM_WEBHOOK_SECRET_TOKEN.
    const without = app({ zoomWebhook: undefined } as unknown as Partial<HttpDeps>);
    expect((await without.signed(recording())).status).not.toBe(200);
    expect(without.calls).toEqual([]);
    const noModule = app({}, ['kernel']);
    expect((await noModule.signed(recording())).status).not.toBe(200);
    expect(noModule.calls).toEqual([]);
    const on = app();
    expect((await on.signed(recording())).status).toBe(200);
    expect(on.authenticate).not.toHaveBeenCalled();
  });

  it('rings the sweep once for a verified recording notice: the host id in lower case as the one parameter, and nothing else of the body', async () => {
    const { signed, calls } = app();
    const response = await signed(recording());
    expect(response.status).toBe(200);
    expect(await bodyOf(response)).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    // The provider is a literal of the statement, the host id its one parameter (never concatenated into the SQL).
    expect(calls[0]?.sql).toContain("crove_kernel.meeting_platform_ring('zoom', $1)");
    expect(calls[0]?.parameters).toEqual([HOST.toLowerCase()]);
    expect(JSON.stringify(calls)).not.toMatch(/download-token-not-real|Họp khách A/);
    // The transcript notice rings too; both are taken with the previous secret while a rotation is under way.
    const transcript = recording({ event: 'recording.transcript_completed', event_ts: 1731931260000 });
    expect((await signed(transcript, TS, PREVIOUS)).status).toBe(200);
    expect(calls).toHaveLength(2);
  });

  it('answers a replay without asking the database, and ignores an event it has no use for, with the same answer', async () => {
    const { signed, calls } = app();
    const first = await signed(recording());
    const again = await signed(recording());
    expect(await bodyOf(again)).toEqual(await bodyOf(first));
    expect(calls).toHaveLength(1);
    // Another instance of the meeting is another notice.
    await signed(recording({ payload: { object: { uuid: 'uuid-2', host_id: HOST } } }));
    expect(calls).toHaveLength(2);
    // Events that are not a finished recording, and one that names no host, are answered 200 and call nothing.
    const before = calls.length;
    for (const other of [JSON.stringify({ event: 'meeting.ended', payload: {} }), recording({ payload: { object: { uuid: 'u', host_id: 'bad host!' } } })]) expect(await bodyOf(await signed(other))).toEqual({ ok: true });
    expect(calls).toHaveLength(before);
  });

  it('forgets a replay after its window, so a later notice rings again', async () => {
    let clock = NOW;
    const replays = new ZoomReplayCache(() => clock);
    const { signed, calls } = app({ zoomReplays: replays });
    await signed(recording());
    await signed(recording());
    expect(calls).toHaveLength(1);
    clock += ZOOM_REPLAY_WINDOW_MS + 1;
    await signed(recording());
    expect(calls).toHaveLength(2);
  });

  it('refuses a missing, wrong, stale or malformed signature with one and the same answer, and calls nothing', async () => {
    const { post, signed, calls } = app();
    const text = recording();
    const answers = [
      await post(text),
      await post(text, { 'x-zm-signature': sign(text), 'x-zm-request-timestamp': '' }),
      await post(text, { 'x-zm-signature': 'v0=00', 'x-zm-request-timestamp': TS }),
      await signed(text, TS, 'another-secret-0123456789'),
      await signed(text, String(Number(TS) - 3600)),
      await signed(text, String(Number(TS) + 3600)),
      await post(text, { 'x-zm-signature': sign(recording({ event_ts: 1 })), 'x-zm-request-timestamp': TS }),
    ];
    for (const answer of answers) {
      expect(answer.status).toBe(401);
      expect(await bodyOf(answer)).toEqual({ code: 'WEBHOOK_SIGNATURE' });
    }
    expect(calls).toEqual([]);
  });

  it('refuses a body over the cap before reading it', async () => {
    const { post, calls } = app();
    const big = JSON.stringify({ event: 'recording.completed', padding: 'x'.repeat(70_000) });
    expect((await post(big, { 'x-zm-signature': sign(big), 'x-zm-request-timestamp': TS })).status).toBe(413);
    expect(calls).toEqual([]);
  });

  it('answers a signed body that is no notice 400, and nothing is called', async () => {
    const { signed, calls } = app();
    for (const text of ['not json', '[]', '{"event":5}']) expect((await signed(text)).status, text).toBe(400);
    expect(calls).toEqual([]);
  });
});

describe('the URL validation challenge', () => {
  const challenge = (plainToken: unknown) => JSON.stringify({ event: 'endpoint.url_validation', payload: { plainToken } });

  it('is answered with the HMAC of the plainToken, signed or not, and the answer carries nothing else', async () => {
    const { post, signed, calls } = app();
    const text = challenge('challenge-token-0001');
    const expected = { plainToken: 'challenge-token-0001', encryptedToken: createHmac('sha256', SECRET).update('challenge-token-0001').digest('hex') };
    expect(await bodyOf(await post(text))).toEqual(expected);
    expect(await bodyOf(await signed(text))).toEqual(expected);
    expect(calls).toEqual([]);
  });

  it('gives no HMAC for a plainToken that is shaped like a signed message (the signing oracle), signed or not', async () => {
    const { post, signed, calls } = app();
    const victim = recording();
    const message = `v0:${TS}:${victim}`;
    const text = challenge(message);
    const unsigned = await post(text);
    expect(unsigned.status).toBe(401);
    const answer = await bodyOf(unsigned);
    expect(answer).toEqual({ code: 'WEBHOOK_SIGNATURE' });
    // What the caller wanted: the signature of `victim`. It is nowhere in any answer.
    const wanted = sign(victim).slice(3);
    expect(JSON.stringify(answer)).not.toContain(wanted);
    const signedAnswer = await signed(text);
    expect(signedAnswer.status).toBe(400);
    expect(JSON.stringify(await bodyOf(signedAnswer))).not.toContain(wanted);
    for (const token of ['v0:1:', 'a b', '', 'x'.repeat(129), 5, null]) expect((await post(challenge(token))).status, String(token)).toBe(401);
    expect(calls).toEqual([]);
  });

  it('is the only event answered without a verified signature, and a signature that is present must be right', async () => {
    const { post } = app();
    expect((await post(recording())).status).toBe(401);
    expect((await post(challenge('abc'), { 'x-zm-signature': 'v0=' + '0'.repeat(64), 'x-zm-request-timestamp': TS })).status).toBe(401);
  });
});

describe('the rate limit', () => {
  it('is charged to refusals and unsigned challenges, never to a verified notice, and answers 429 with a retry time', async () => {
    const { post, signed } = app({ zoomWebhookLimit: new RateLimiter({ perMinute: 3 }) });
    // Verified notices are not counted, however many.
    for (let i = 0; i < 10; i += 1) expect((await signed(recording({ event_ts: 1731931200000 + i }))).status).toBe(200);
    // Three refusals are allowed through as 401, the fourth is a 429.
    for (let i = 0; i < 3; i += 1) expect((await post(recording())).status).toBe(401);
    const limited = await post(recording());
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    // A verified notice still gets through from the same address.
    expect((await signed(recording({ event_ts: 5 }))).status).toBe(200);
  });

  it('counts an unsigned challenge against the same limit', async () => {
    const { post } = app({ zoomWebhookLimit: new RateLimiter({ perMinute: 2 }) });
    const text = JSON.stringify({ event: 'endpoint.url_validation', payload: { plainToken: 'abc' } });
    expect((await post(text)).status).toBe(200);
    expect((await post(text)).status).toBe(200);
    expect((await post(text)).status).toBe(429);
  });
});

describe('what reaches a log', () => {
  it('is nothing of a body, a token or a signature, whatever the outcome', async () => {
    const { post, signed } = app();
    await signed(recording());
    await post(recording());
    await signed('not json');
    await post(JSON.stringify({ event: 'endpoint.url_validation', payload: { plainToken: 'plain-token-not-real' } }));
    const all = logs.join('\n');
    for (const secret of ['download-token-not-real', 'Họp khách A', HOST, SECRET, 'plain-token-not-real', 'not json', sign(recording())]) expect(all, secret).not.toContain(secret);
  });
});

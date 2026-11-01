// SPDX-License-Identifier: AGPL-3.0-only
// The split deployment's CORS (#2261): an exact-origin allowlist, never a wildcard, answered before the session check, and
// the settings that go with it (APP_URL, CORS_ALLOWED_ORIGINS).
import { describe, expect, it } from 'vitest';
import { ORG_HEADER } from '@crove/kernel-contract';
import type pg from 'pg';
import { DomainError, type BlobStore, type Runtime } from '@crove/kernel-runtime';
import { appUrl, loadConfig } from '../src/config.ts';
import { corsMiddleware, parseAllowedOrigins } from '../src/cors.ts';
import { createHttpApp } from '../src/http.ts';

const APP = 'https://app.example.com';
const base = { DATABASE_URL: 'postgres://localhost/x', AUTH_JWT_SECRET: 'x'.repeat(32), AUTH_ISSUER: 'crove-auth', WEB_DIST: '/nonexistent' };

describe('CORS_ALLOWED_ORIGINS', () => {
  it('is empty when unset, blank or only separators', () => {
    expect(parseAllowedOrigins(undefined)).toEqual([]);
    expect(parseAllowedOrigins(' , ')).toEqual([]);
    expect(loadConfig(base).CORS_ALLOWED_ORIGINS).toEqual([]);
    expect(loadConfig({ ...base, CORS_ALLOWED_ORIGINS: '' }).CORS_ALLOWED_ORIGINS).toEqual([]);
  });

  it('takes exact https origins, trims and drops repeats; http only for localhost', () => {
    expect(parseAllowedOrigins(` ${APP} , https://other.example.com:8443,${APP}`)).toEqual([APP, 'https://other.example.com:8443']);
    expect(parseAllowedOrigins('http://localhost:5173,http://127.0.0.1:5173')).toEqual(['http://localhost:5173', 'http://127.0.0.1:5173']);
  });

  it('refuses a wildcard, a path, a trailing slash, plain http and what is not an origin', () => {
    for (const bad of ['*', 'https://*.example.com', `${APP}/`, `${APP}/app`, 'http://app.example.com', 'ftp://app.example.com', 'app.example.com', 'null', `${APP}?x=1`]) {
      expect(() => parseAllowedOrigins(bad), bad).toThrow(/CORS_ALLOWED_ORIGINS/);
    }
    expect(() => loadConfig({ ...base, CORS_ALLOWED_ORIGINS: '*' })).toThrow(/wildcard/);
    expect(() => parseAllowedOrigins(Array.from({ length: 11 }, (_, i) => `https://a${i}.example.com`).join(','))).toThrow(/at most/);
  });
});

describe('APP_URL', () => {
  it('is the app address when set and PUBLIC_URL otherwise', () => {
    expect(appUrl(loadConfig(base))).toBe('http://localhost:8080');
    expect(loadConfig({ ...base, APP_URL: '' }).APP_URL).toBeUndefined();
    const split = loadConfig({ ...base, PUBLIC_URL: 'https://api.example.com', APP_URL: APP, CORS_ALLOWED_ORIGINS: APP, AUTH_UPSTREAM_URL: 'http://auth:9999' });
    expect(appUrl(split)).toBe(APP);
    expect(split.PUBLIC_URL).toBe('https://api.example.com');
  });

  it('must be listed in CORS_ALLOWED_ORIGINS when it is another origin than PUBLIC_URL', () => {
    const env = { ...base, PUBLIC_URL: 'https://api.example.com', AUTH_UPSTREAM_URL: 'http://auth:9999' };
    expect(() => loadConfig({ ...env, APP_URL: APP })).toThrow(new RegExp(`list ${APP} in CORS_ALLOWED_ORIGINS`));
    expect(() => loadConfig({ ...env, APP_URL: APP, CORS_ALLOWED_ORIGINS: 'https://other.example.com' })).toThrow(/CORS_ALLOWED_ORIGINS/);
    expect(() => loadConfig({ ...env, APP_URL: APP, CORS_ALLOWED_ORIGINS: APP })).not.toThrow();
    // The same origin as PUBLIC_URL (a path on it) needs no CORS.
    expect(() => loadConfig({ ...env, APP_URL: 'https://api.example.com/app' })).not.toThrow();
  });

  it('must be https on a public deployment', () => {
    const env = { ...base, PUBLIC_URL: 'https://api.example.com', AUTH_UPSTREAM_URL: 'http://auth:9999', CORS_ALLOWED_ORIGINS: 'http://localhost:5173' };
    expect(() => loadConfig({ ...env, APP_URL: 'http://localhost:5173' })).toThrow(/APP_URL.*https/);
  });

  it('refuses an http origin in CORS_ALLOWED_ORIGINS on a public deployment', () => {
    const env = { ...base, PUBLIC_URL: 'https://api.example.com', AUTH_UPSTREAM_URL: 'http://auth:9999' };
    expect(() => loadConfig({ ...env, CORS_ALLOWED_ORIGINS: 'http://localhost:5173' })).toThrow(/http origin on a public deployment/);
    expect(loadConfig({ ...base, CORS_ALLOWED_ORIGINS: 'http://localhost:5173' }).CORS_ALLOWED_ORIGINS).toEqual(['http://localhost:5173']);
  });

  it('is where channel OAuth returns, so a public app must be https when an app is set', () => {
    const env = { ...base, PUBLIC_URL: 'https://api.example.com', AUTH_UPSTREAM_URL: 'http://auth:9999', CHANNEL_TELEGRAM: 'true', CALENDAR_GOOGLE_CLIENT_ID: '123456-abcdefgh.apps.googleusercontent.com', CALENDAR_GOOGLE_CLIENT_SECRET: 's' };
    expect(() => loadConfig({ ...env, APP_URL: APP, CORS_ALLOWED_ORIGINS: APP })).not.toThrow();
  });
});

describe('corsMiddleware', () => {
  async function appWith(allowed: readonly string[]) {
    const { Hono } = await import('hono');
    const app = new Hono();
    app.use('*', corsMiddleware(allowed));
    app.get('/x', (c) => c.json({ ok: true }));
    app.post('/x', (c) => c.json({ ok: true }));
    // A handler that returns its own Response, as the auth proxy does with Supabase Auth's answer, wildcard CORS included.
    app.get('/raw', () => new Response('raw', { headers: { 'access-control-allow-origin': '*', 'access-control-allow-credentials': 'true' } }));
    return app;
  }
  const preflight = (origin: string) => ({ method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': `authorization,content-type,${ORG_HEADER}` } });

  it('does nothing with an empty list: no header, the route answers', async () => {
    const app = await appWith([]);
    const answer = await app.request('/x', { headers: { origin: APP } });
    expect(answer.status).toBe(200);
    expect(answer.headers.get('access-control-allow-origin')).toBeNull();
    expect(answer.headers.get('vary')).toBeNull();
  });

  it('echoes an allowed origin, never a wildcard, and never allows credentials', async () => {
    const app = await appWith([APP]);
    const answer = await app.request('/x', { headers: { origin: APP } });
    expect(answer.headers.get('access-control-allow-origin')).toBe(APP);
    expect(answer.headers.get('access-control-allow-credentials')).toBeNull();
    expect(answer.headers.get('vary')).toContain('Origin');
    expect(answer.headers.get('access-control-expose-headers')).toContain('x-request-id');
  });

  it('answers a preflight of an allowed origin with its methods and the headers the app sends', async () => {
    const answer = await (await appWith([APP])).request('/x', preflight(APP));
    expect(answer.status).toBe(204);
    expect(answer.headers.get('access-control-allow-origin')).toBe(APP);
    expect(answer.headers.get('access-control-allow-methods')).toContain('POST');
    const headers = answer.headers.get('access-control-allow-headers') ?? '';
    for (const name of ['authorization', 'content-type', ORG_HEADER, 'apikey', 'x-crove-invite']) expect(headers).toContain(name);
    expect(headers).not.toContain('*');
    expect(answer.headers.get('access-control-allow-credentials')).toBeNull();
  });

  it('gives an origin off the list no CORS header: a preflight ends empty, a request is served without one', async () => {
    const app = await appWith([APP]);
    for (const stranger of ['https://evil.example.com', 'http://app.example.com', 'https://app.example.com.evil.com', 'null']) {
      const asked = await app.request('/x', preflight(stranger));
      expect(asked.status, stranger).toBe(204);
      expect(asked.headers.get('access-control-allow-origin'), stranger).toBeNull();
      expect(asked.headers.get('access-control-allow-methods'), stranger).toBeNull();
      const served = await app.request('/x', { headers: { origin: stranger } });
      expect(served.headers.get('access-control-allow-origin'), stranger).toBeNull();
    }
  });

  it('puts its headers on an answer a handler built itself, and drops the upstream ones', async () => {
    const app = await appWith([APP]);
    const allowed = await app.request('/raw', { headers: { origin: APP } });
    expect(allowed.headers.get('access-control-allow-origin')).toBe(APP);
    expect(allowed.headers.get('access-control-allow-credentials')).toBeNull();
    expect(await allowed.text()).toBe('raw');
    const stranger = await app.request('/raw', { headers: { origin: 'https://evil.example.com' } });
    expect(stranger.headers.get('access-control-allow-origin')).toBeNull();
    expect(stranger.headers.get('access-control-allow-credentials')).toBeNull();
    expect(stranger.headers.get('vary')).toContain('Origin');
  });

  it('leaves a request with no Origin header without CORS headers (same origin, curl), but still varying by Origin', async () => {
    const answer = await (await appWith([APP])).request('/x');
    expect(answer.status).toBe(200);
    expect(answer.headers.get('access-control-allow-origin')).toBeNull();
    expect(answer.headers.get('vary')).toContain('Origin');
  });

  it('lets a fetch with cache: no-store through the preflight', async () => {
    const answer = await (await appWith([APP])).request('/x', { method: 'OPTIONS', headers: { origin: APP, 'access-control-request-method': 'GET', 'access-control-request-headers': 'cache-control,pragma' } });
    const headers = answer.headers.get('access-control-allow-headers') ?? '';
    expect(headers).toContain('cache-control');
    expect(headers).toContain('pragma');
  });
});

describe('the HTTP app with CORS_ALLOWED_ORIGINS', () => {
  function app(env: Record<string, string>) {
    const calls = { authenticate: 0 };
    const http = createHttpApp({
      config: loadConfig({ ...base, ...env }),
      runtime: { installed: () => true, modules: () => ['kernel'] } as unknown as Runtime,
      store: {} as BlobStore,
      authenticate: async () => {
        calls.authenticate += 1;
        throw new DomainError('UNAUTHENTICATED', 401, 'no session');
      },
      pool: {} as pg.Pool,
      aiEnabled: false,
    });
    return { http, calls };
  }
  const split = { PUBLIC_URL: 'https://api.example.com', APP_URL: APP, CORS_ALLOWED_ORIGINS: APP, AUTH_UPSTREAM_URL: 'http://auth:9999' };
  const preflight = (origin: string) => ({ method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type' } });

  it('answers the app origin on the RPC, the stream ticket and the auth proxy before any session check', async () => {
    const { http, calls } = app(split);
    for (const path of ['/api/rpc/me/get', '/api/stream/tickets', '/api/config', '/auth/v1/token', '/version']) {
      const answer = await http.request(path, preflight(APP));
      expect(answer.status, path).toBe(204);
      expect(answer.headers.get('access-control-allow-origin'), path).toBe(APP);
    }
    expect(calls.authenticate).toBe(0);
  });

  it('refuses every other origin the same preflights', async () => {
    const { http } = app(split);
    for (const path of ['/api/rpc/me/get', '/api/stream/tickets', '/api/config', '/auth/v1/token']) {
      const answer = await http.request(path, preflight('https://evil.example.com'));
      expect(answer.headers.get('access-control-allow-origin'), path).toBeNull();
    }
  });

  it('adds the headers to a real answer, and a request that needs a token still gets 401 from authenticate', async () => {
    const { http, calls } = app(split);
    const open = await http.request('/api/config', { headers: { origin: APP } });
    expect(open.status).toBe(200);
    expect(open.headers.get('access-control-allow-origin')).toBe(APP);
    const refused = await http.request('/api/rpc/me/get', { method: 'POST', headers: { origin: APP, 'content-type': 'application/json' }, body: '{}' });
    expect(refused.status).toBe(401);
    expect(refused.headers.get('access-control-allow-origin')).toBe(APP);
    expect(calls.authenticate).toBe(1);
  });

  it('keeps the secure headers and sends no CORS header at all without the setting (self-host)', async () => {
    const { http } = app({});
    const answer = await http.request('/api/config', { headers: { origin: APP } });
    expect(answer.headers.get('access-control-allow-origin')).toBeNull();
    expect(answer.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('points the public config at the API for sign-in while the links in mail use the app', async () => {
    const { http } = app(split);
    const config = (await (await http.request('/api/config')).json()) as { authUrl: string };
    expect(config.authUrl).toBe('https://api.example.com/auth/v1');
  });
});

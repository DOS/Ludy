// SPDX-License-Identifier: AGPL-3.0-only
// The hosted login's settings (issue #2704, docs/contracts/hosted-login.md): both addresses or neither, https, the app told, the
// token endpoint's origin in the policy of the app the kernel serves.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import type { BlobStore, Runtime } from '@crove/kernel-runtime';
import { hostedLoginTokenOrigin, hostedLoginView } from '../src/auth-hosted-login.ts';
import { loadConfig } from '../src/config.ts';
import { contentSecurityPolicy, createHttpApp } from '../src/http.ts';

const BASE = {
  DATABASE_URL: 'postgres://localhost/x',
  AUTH_JWT_SECRET: 'unit-test-jwt-secret-0123456789abcdef',
  AUTH_ISSUER: 'crove-auth',
};
const URLS = { AUTH_HOSTED_LOGIN_URL: 'https://login.example.test/sign-in', AUTH_HOSTED_LOGIN_TOKEN_URL: 'https://login.example.test/token' };

describe('AUTH_HOSTED_LOGIN_*', () => {
  it('is off without the settings and on with both addresses', () => {
    expect(hostedLoginView(loadConfig(BASE))).toBeNull();
    expect(hostedLoginTokenOrigin(loadConfig(BASE))).toBeNull();
    const config = loadConfig({ ...BASE, ...URLS, AUTH_HOSTED_LOGIN_NAME: 'Example ID' });
    expect(hostedLoginView(config)).toEqual({ url: URLS.AUTH_HOSTED_LOGIN_URL, tokenUrl: URLS.AUTH_HOSTED_LOGIN_TOKEN_URL, name: 'Example ID' });
    expect(hostedLoginTokenOrigin(config)).toBe('https://login.example.test');
    expect(hostedLoginView(loadConfig({ ...BASE, ...URLS }))?.name).toBeNull();
  });

  it('stops the boot on one address without the other, on a non-https or unusable address, and on a bad name', () => {
    expect(() => loadConfig({ ...BASE, AUTH_HOSTED_LOGIN_URL: URLS.AUTH_HOSTED_LOGIN_URL })).toThrow(/both AUTH_HOSTED_LOGIN_URL and AUTH_HOSTED_LOGIN_TOKEN_URL/);
    expect(() => loadConfig({ ...BASE, AUTH_HOSTED_LOGIN_TOKEN_URL: URLS.AUTH_HOSTED_LOGIN_TOKEN_URL })).toThrow(/both AUTH_HOSTED_LOGIN_URL/);
    expect(() => loadConfig({ ...BASE, ...URLS, AUTH_HOSTED_LOGIN_TOKEN_URL: 'http://login.example.test/token' })).toThrow(/must be https/);
    expect(() => loadConfig({ ...BASE, ...URLS, AUTH_HOSTED_LOGIN_URL: 'javascript:alert(1)' })).toThrow(/AUTH_HOSTED_LOGIN_URL/);
    expect(() => loadConfig({ ...BASE, ...URLS, AUTH_HOSTED_LOGIN_URL: 'https://user:pw@login.example.test/' })).toThrow(/credentials/);
    expect(() => loadConfig({ ...BASE, ...URLS, AUTH_HOSTED_LOGIN_URL: 'https://login.example.test/#x' })).toThrow(/fragment/);
    expect(() => loadConfig({ ...BASE, ...URLS, AUTH_HOSTED_LOGIN_URL: 'not a url' })).toThrow(/not a URL/);
    expect(() => loadConfig({ ...BASE, ...URLS, AUTH_HOSTED_LOGIN_NAME: 'x'.repeat(41) })).toThrow(/AUTH_HOSTED_LOGIN_NAME/);
    expect(() => loadConfig({ ...BASE, ...URLS, AUTH_HOSTED_LOGIN_NAME: '<b>x</b>' })).toThrow(/AUTH_HOSTED_LOGIN_NAME/);
  });

  it('accepts http for a login page on this machine, for development', () => {
    expect(hostedLoginView(loadConfig({ ...BASE, AUTH_HOSTED_LOGIN_URL: 'http://localhost:4000/login', AUTH_HOSTED_LOGIN_TOKEN_URL: 'http://localhost:4000/token' }))?.url).toBe('http://localhost:4000/login');
  });

  it('is handed to the app through /api/config, or null', async () => {
    const hosted = async (env: Record<string, string>) => {
      const app = createHttpApp({
        config: loadConfig({ ...BASE, WEB_DIST: '/nonexistent', ...env }),
        runtime: { installed: () => true, modules: () => ['kernel'] } as unknown as Runtime,
        store: {} as BlobStore,
        authenticate: async () => {
          throw new Error('not used');
        },
        pool: {} as pg.Pool,
        aiEnabled: false,
      });
      return ((await (await app.request('/api/config')).json()) as { hostedLogin: unknown }).hostedLogin;
    };
    expect(await hosted({})).toBeNull();
    expect(await hosted(URLS)).toEqual({ url: URLS.AUTH_HOSTED_LOGIN_URL, tokenUrl: URLS.AUTH_HOSTED_LOGIN_TOKEN_URL, name: null });
  });

  it('adds only the token endpoint origin to the policy of the app the kernel serves', () => {
    expect(contentSecurityPolicy('/auth/v1', null)).not.toContain('login.example.test');
    expect(contentSecurityPolicy('/auth/v1', null, false, null, 'https://login.example.test')).toContain("connect-src 'self' http://localhost https://login.example.test;");
  });

  it('sends the served app that policy, and the callback path gets the app like any other deep link', async () => {
    const dist = mkdtempSync(join(tmpdir(), 'crove-web-'));
    try {
      writeFileSync(join(dist, 'index.html'), '<!doctype html><title>app</title>');
      const served = (env: Record<string, string>) =>
        createHttpApp({
          config: loadConfig({ ...BASE, WEB_DIST: dist, ...env }),
          runtime: { installed: () => true, modules: () => ['kernel'] } as unknown as Runtime,
          store: {} as BlobStore,
          authenticate: async () => {
            throw new Error('not used');
          },
          pool: {} as pg.Pool,
          aiEnabled: false,
        });
      const on = await served(URLS).request('/hosted-login/callback?code=abc&state=def');
      expect(on.status).toBe(200);
      expect(on.headers.get('content-security-policy')).toContain('https://login.example.test');
      const off = await served({}).request('/hosted-login/callback');
      expect(off.headers.get('content-security-policy')).not.toContain('login.example.test');
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  });
});

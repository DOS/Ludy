// SPDX-License-Identifier: AGPL-3.0-only
// The settings of signing in through the identity provider's OAuth App (issue #4704, ADR-0028 amendment 2026-11-24):
// AUTH_OAUTH_CLIENT_ID alone only widens what the kernel accepts; AUTH_SIGN_IN=oauth also changes the sign-in screen and fails
// closed at boot when it cannot be offered whole; the app is told through /api/config; the callback path serves the app.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import type { BlobStore, Runtime } from '@ludy/kernel-runtime';
import { oauthName, oauthSignInView, parseOauthClientId } from '../src/auth-oauth.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';

const BASE = {
  DATABASE_URL: 'postgres://localhost/x',
  AUTH_JWT_SECRET: 'unit-test-jwt-secret-0123456789abcdef',
  AUTH_ISSUER: 'crove-auth',
};
const CLIENT = '3f2b8a9e-6c1d-4e7a-9b5f-0d1c2e3f4a5b';
const ON = { AUTH_SIGN_IN: 'oauth', AUTH_OAUTH_CLIENT_ID: CLIENT, PUBLIC_AUTH_URL: 'https://id.example.test/auth/v1', AUTH_OAUTH_NAME: 'Example ID' };

describe('AUTH_SIGN_IN and AUTH_OAUTH_*', () => {
  it('is off by default: the form, no client, no view', () => {
    const config = loadConfig(BASE);
    expect(config.AUTH_SIGN_IN).toBe('form');
    expect(config.AUTH_OAUTH_CLIENT_ID).toBeUndefined();
    expect(oauthSignInView(config)).toBeNull();
    // Empty values count as unset (compose passes them through empty).
    expect(loadConfig({ ...BASE, AUTH_SIGN_IN: '', AUTH_OAUTH_CLIENT_ID: '', AUTH_OAUTH_NAME: '' }).AUTH_SIGN_IN).toBe('form');
  });

  it('with only the client id, widens what is accepted and changes nothing on the sign-in screen', () => {
    const config = loadConfig({ ...BASE, AUTH_OAUTH_CLIENT_ID: CLIENT.toUpperCase() });
    expect(config.AUTH_OAUTH_CLIENT_ID).toBe(CLIENT);
    expect(oauthSignInView(config)).toBeNull();
  });

  it('in oauth mode gives the app the endpoints under the identity provider\'s Auth URL', () => {
    const view = oauthSignInView(loadConfig({ ...BASE, ...ON }));
    expect(view).toEqual({ clientId: CLIENT, authorizeUrl: 'https://id.example.test/auth/v1/oauth/authorize', tokenUrl: 'https://id.example.test/auth/v1/oauth/token', name: 'Example ID' });
    expect(oauthSignInView(loadConfig({ ...BASE, ...ON, PUBLIC_AUTH_URL: 'https://id.example.test/auth/v1/', AUTH_OAUTH_NAME: '' }))).toMatchObject({ tokenUrl: 'https://id.example.test/auth/v1/oauth/token', name: null });
  });

  it('fails closed at boot when oauth mode is incomplete or mixed with another way in', () => {
    const { AUTH_OAUTH_CLIENT_ID: _client, ...noClient } = ON;
    const { PUBLIC_AUTH_URL: _url, ...noUrl } = ON;
    expect(() => loadConfig({ ...BASE, ...noClient })).toThrow(/AUTH_SIGN_IN=oauth needs AUTH_OAUTH_CLIENT_ID/);
    expect(() => loadConfig({ ...BASE, ...noUrl })).toThrow(/AUTH_SIGN_IN=oauth needs PUBLIC_AUTH_URL/);
    expect(() => loadConfig({ ...BASE, ...ON, PUBLIC_AUTH_URL: 'http://id.example.test/auth/v1' })).toThrow(/must be https/);
    expect(() => loadConfig({ ...BASE, ...ON, PUBLIC_AUTH_URL: 'https://id.example.test/auth/v1?x=1' })).toThrow(/no credentials, query or fragment/);
    expect(() => loadConfig({ ...BASE, ...ON, AUTH_UPSTREAM_URL: 'http://auth:9999' })).toThrow(/cannot be combined with AUTH_UPSTREAM_URL/);
    expect(() => loadConfig({ ...BASE, ...ON, AUTH_HOSTED_LOGIN_URL: 'https://login.example.test/', AUTH_HOSTED_LOGIN_TOKEN_URL: 'https://login.example.test/token' })).toThrow(/cannot be combined with AUTH_HOSTED_LOGIN_URL/);
    expect(() => loadConfig({ ...BASE, ...ON, AUTH_OAUTH_PROVIDERS: 'google' })).toThrow(/cannot be combined with AUTH_OAUTH_PROVIDERS/);
    expect(() => loadConfig({ ...BASE, ...ON, AUTH_OAUTH_NAME: '<b>x</b>' })).toThrow(/AUTH_OAUTH_NAME/);
    expect(() => loadConfig({ ...BASE, ...ON, AUTH_SIGN_IN: 'both' })).toThrow(/AUTH_SIGN_IN/);
  });

  it('refuses a client id that is not a UUID, and a localhost Auth URL on a public deployment', () => {
    for (const bad of ['not-a-uuid', `${CLIENT}0`, 'ludy']) expect(() => loadConfig({ ...BASE, AUTH_OAUTH_CLIENT_ID: bad }), bad).toThrow(/AUTH_OAUTH_CLIENT_ID/);
    const publicDeployment = { PUBLIC_URL: 'https://books.example.com', CROVE_CONTEXT_TOKEN_KEY: Buffer.alloc(48, 5).toString('base64'), EXPORT_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'), AUTH_AUTOCONFIRM: 'false' };
    expect(() => loadConfig({ ...BASE, ...publicDeployment, ...ON })).not.toThrow();
    expect(() => loadConfig({ ...BASE, ...publicDeployment, ...ON, PUBLIC_AUTH_URL: 'http://localhost:9999/auth/v1' })).toThrow(/localhost address on a public PUBLIC_URL/);
  });

  it('takes a plain label for the button', () => {
    expect(oauthName(undefined)).toBeNull();
    expect(oauthName('Example ID')).toBe('Example ID');
    expect(oauthName('x'.repeat(41))).toBeNull();
    expect(oauthName('a\u0007b')).toBeNull();
    expect(parseOauthClientId(` ${CLIENT} `)).toBe(CLIENT);
  });

  const appFor = (env: Record<string, string>, dist = '/nonexistent') =>
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

  it('is handed to the app through /api/config', async () => {
    const read = async (env: Record<string, string>) => (await (await appFor(env).request('/api/config')).json()) as { signIn: string; oauthSignIn: unknown };
    expect(await read({})).toMatchObject({ signIn: 'form', oauthSignIn: null });
    expect(await read({ AUTH_OAUTH_CLIENT_ID: CLIENT })).toMatchObject({ signIn: 'form', oauthSignIn: null });
    expect(await read(ON)).toMatchObject({ signIn: 'oauth', oauthSignIn: { clientId: CLIENT, name: 'Example ID' } });
  });

  it('serves the app at the callback path like any other deep link, and adds the Auth origin to its policy only once', async () => {
    const dist = mkdtempSync(join(tmpdir(), 'ludy-web-'));
    try {
      writeFileSync(join(dist, 'index.html'), '<!doctype html><title>app</title>');
      const on = await appFor(ON, dist).request('/oauth-login/callback?code=abc&state=def');
      expect(on.status).toBe(200);
      expect(on.headers.get('content-security-policy')).toContain('https://id.example.test');
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  });
});

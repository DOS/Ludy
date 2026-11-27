// SPDX-License-Identifier: AGPL-3.0-only
// Unit tests for GitHub App configuration completeness, sample-secret rejection, and public HTTPS callback enforcement (#5158 B1 + N3).
import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

const BASE = {
  DATABASE_URL: 'postgres://localhost/x',
  AUTH_JWT_SECRET: 'unit-test-jwt-secret-0123456789abcdef',
  AUTH_ISSUER: 'crove-auth',
};

const FULL_GITHUB_APP = {
  GITHUB_APP_ID: '123456',
  GITHUB_APP_PRIVATE_KEY: PEM,
  GITHUB_APP_CLIENT_ID: 'Iv1.testclientid',
  GITHUB_APP_CLIENT_SECRET: 'github-app-client-secret-real-value',
  GITHUB_APP_WEBHOOK_SECRET: 'github-app-webhook-secret-real-value',
};

describe('GitHub App configuration', () => {
  it('accepts none or the full set of five required GitHub App variables and rejects partial sets', () => {
    const empty = loadConfig({ ...BASE });
    expect(empty.GITHUB_APP_ID).toBeUndefined();
    expect(empty.GITHUB_APP_CLIENT_ID).toBeUndefined();

    const full = loadConfig({ ...BASE, ...FULL_GITHUB_APP });
    expect(full.GITHUB_APP_ID).toBe('123456');
    expect(full.GITHUB_APP_CLIENT_ID).toBe('Iv1.testclientid');

    for (const omitted of Object.keys(FULL_GITHUB_APP) as Array<keyof typeof FULL_GITHUB_APP>) {
      const partial: Record<string, string> = { ...BASE, ...FULL_GITHUB_APP };
      delete partial[omitted];
      expect(() => loadConfig(partial), `missing ${omitted}`).toThrow(/together, or none/);
    }
  });

  it('rejects sample change-me secrets on GITHUB_APP_WEBHOOK_SECRET, GITHUB_APP_CLIENT_SECRET, and previous webhook secret (N3)', () => {
    expect(() =>
      loadConfig({
        ...BASE,
        ...FULL_GITHUB_APP,
        GITHUB_APP_WEBHOOK_SECRET: 'change-me-webhook-secret-012345',
      }),
    ).toThrow(/GITHUB_APP_WEBHOOK_SECRET still has a sample value/);

    expect(() =>
      loadConfig({
        ...BASE,
        ...FULL_GITHUB_APP,
        GITHUB_APP_CLIENT_SECRET: 'change-me-client-secret-012345',
      }),
    ).toThrow(/GITHUB_APP_CLIENT_SECRET still has a sample value/);

    expect(() =>
      loadConfig({
        ...BASE,
        ...FULL_GITHUB_APP,
        GITHUB_APP_WEBHOOK_SECRET_PREVIOUS: 'change-me-prev-secret-012345',
      }),
    ).toThrow(/GITHUB_APP_WEBHOOK_SECRET_PREVIOUS still has a sample value/);
  });

  it('enforces https callback origin on public deployments when GITHUB_APP_CLIENT_ID is set', () => {
    const publicBase = {
      ...BASE,
      ...FULL_GITHUB_APP,
      AUTH_SESSION_CHECK: 'jwt',
      PUBLIC_AUTH_URL: 'https://auth.example.test',
      WEB_DIST: '/nonexistent',
      PUBLIC_URL: 'https://ludy.example.test',
      APP_URL: 'http://ludy.example.test',
    };
    expect(() => loadConfig(publicBase)).toThrow(/GITHUB_APP_CLIENT_ID/);
  });
});

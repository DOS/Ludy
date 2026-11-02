// SPDX-License-Identifier: AGPL-3.0-only
// The OA secret key of the Zalo app (conversation core, #2304): optional, needs the app, has a shape, and is a secret the pilot check
// refuses a sample value of.
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';

const BASE = { DATABASE_URL: 'postgres://localhost/x', AUTH_JWT_SECRET: 'unit-test-jwt-secret-0123456789abcdef', AUTH_ISSUER: 'crove-auth' };
const APP = { CHANNEL_ZALO_APP_ID: '4318000000000000001', CHANNEL_ZALO_APP_SECRET: 'app-secret-not-real' };

describe('CHANNEL_ZALO_OA_SECRET_KEY', () => {
  it('is optional, and set with the Zalo app', () => {
    expect(loadConfig({ ...BASE }).CHANNEL_ZALO_OA_SECRET_KEY).toBeUndefined();
    expect(loadConfig({ ...BASE, ...APP }).CHANNEL_ZALO_OA_SECRET_KEY).toBeUndefined();
    expect(loadConfig({ ...BASE, ...APP, CHANNEL_ZALO_OA_SECRET_KEY: 'oa-secret-key-not-real' }).CHANNEL_ZALO_OA_SECRET_KEY).toBe('oa-secret-key-not-real');
  });

  it('has a previous key for a rotation: only beside the current one, with a key shape, and not the same', () => {
    const base = { ...BASE, ...APP, CHANNEL_ZALO_OA_SECRET_KEY: 'oa-secret-key-not-real' };
    expect(loadConfig({ ...base, CHANNEL_ZALO_OA_SECRET_KEY_PREVIOUS: 'oa-secret-key-older' }).CHANNEL_ZALO_OA_SECRET_KEY_PREVIOUS).toBe('oa-secret-key-older');
    expect(() => loadConfig({ ...BASE, ...APP, CHANNEL_ZALO_OA_SECRET_KEY_PREVIOUS: 'oa-secret-key-older' })).toThrow(/without CHANNEL_ZALO_OA_SECRET_KEY/);
    expect(() => loadConfig({ ...base, CHANNEL_ZALO_OA_SECRET_KEY_PREVIOUS: 'short' })).toThrow(/CHANNEL_ZALO_OA_SECRET_KEY_PREVIOUS/);
    expect(() => loadConfig({ ...base, CHANNEL_ZALO_OA_SECRET_KEY_PREVIOUS: 'oa-secret-key-not-real' })).toThrow(/same as/);
  });

  it('is refused without the app, and with a shape that is not a key', () => {
    expect(() => loadConfig({ ...BASE, CHANNEL_ZALO_OA_SECRET_KEY: 'oa-secret-key-not-real' })).toThrow(/needs CHANNEL_ZALO_APP_ID/);
    for (const bad of ['short', 'has a space in it', 'x'.repeat(201)]) {
      expect(() => loadConfig({ ...BASE, ...APP, CHANNEL_ZALO_OA_SECRET_KEY: bad }), bad).toThrow(/CHANNEL_ZALO_OA_SECRET_KEY/);
    }
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
// MEDIA_UPLOAD_REQUEST_TIMEOUT_S stays under the staging sweep's age (#2843 N5).
import { describe, expect, it } from 'vitest';
import { MEDIA_UPLOAD_REQUEST_TIMEOUT_MAX_S, loadConfig } from '../src/config.ts';
import { STAGING_MAX_AGE_MS } from '../src/retention.ts';

const base = {
  DATABASE_URL: 'postgres://localhost/x',
  AUTH_JWT_SECRET: 'x'.repeat(32),
  AUTH_ISSUER: 'crove-auth',
  PUBLIC_URL: 'https://books.example.com',
  AUTH_UPSTREAM_URL: 'http://auth:9999',
};

describe('MEDIA_UPLOAD_REQUEST_TIMEOUT_S', () => {
  it('defaults to 2700, accepts 2700 and the maximum, and refuses the sweep age and beyond', () => {
    expect(loadConfig(base).MEDIA_UPLOAD_REQUEST_TIMEOUT_S).toBe(2700);
    expect(loadConfig({ ...base, MEDIA_UPLOAD_REQUEST_TIMEOUT_S: '2700' }).MEDIA_UPLOAD_REQUEST_TIMEOUT_S).toBe(2700);
    expect(MEDIA_UPLOAD_REQUEST_TIMEOUT_MAX_S).toBe(3300);
    expect(MEDIA_UPLOAD_REQUEST_TIMEOUT_MAX_S * 1000).toBeLessThan(STAGING_MAX_AGE_MS);
    expect(loadConfig({ ...base, MEDIA_UPLOAD_REQUEST_TIMEOUT_S: '3300' }).MEDIA_UPLOAD_REQUEST_TIMEOUT_S).toBe(3300);
    for (const bad of ['3301', '3600', '21600']) {
      expect(() => loadConfig({ ...base, MEDIA_UPLOAD_REQUEST_TIMEOUT_S: bad })).toThrow(/MEDIA_UPLOAD_REQUEST_TIMEOUT_S/);
    }
    expect(() => loadConfig({ ...base, MEDIA_UPLOAD_REQUEST_TIMEOUT_S: '299' })).toThrow(/MEDIA_UPLOAD_REQUEST_TIMEOUT_S/);
  });
});

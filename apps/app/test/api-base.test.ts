// SPDX-License-Identifier: AGPL-3.0-only
// Where the API is (#2261): the same origin by default, the build's VITE_API_URL when the app is served apart.
import { describe, expect, it } from 'vitest';
import { apiUrl, normalizeApiBase } from '../src/lib/api-base.ts';

describe('normalizeApiBase', () => {
  it('is the same origin (empty) when unset or blank', () => {
    expect(normalizeApiBase(undefined)).toBe('');
    expect(normalizeApiBase('')).toBe('');
    expect(normalizeApiBase('   ')).toBe('');
  });

  it('keeps an http(s) origin and drops trailing slashes', () => {
    expect(normalizeApiBase('https://api.example.com')).toBe('https://api.example.com');
    expect(normalizeApiBase(' https://api.example.com/ ')).toBe('https://api.example.com');
    expect(normalizeApiBase('http://localhost:8080')).toBe('http://localhost:8080');
  });

  it('refuses what is not an origin, so a build mistake stops the app instead of sending sessions elsewhere', () => {
    for (const bad of ['api.example.com', 'https://api.example.com/v1', 'https://api.example.com?x=1', 'ftp://api.example.com', 'javascript:alert(1)', 'https://user:pass@api.example.com']) {
      expect(() => normalizeApiBase(bad), bad).toThrow(/VITE_API_URL/);
    }
  });
});

describe('apiUrl', () => {
  it('stays a same-origin path when no API origin is set', () => {
    expect(apiUrl('/api/config', '')).toBe('/api/config');
  });

  it('puts the API origin in front of a path', () => {
    expect(apiUrl('/api/stream?ticket=a%20b', 'https://api.example.com')).toBe('https://api.example.com/api/stream?ticket=a%20b');
    expect(apiUrl('/version', 'https://api.example.com')).toBe('https://api.example.com/version');
  });

  it('leaves an absolute URL (a presigned one) as it is', () => {
    expect(apiUrl('https://bucket.example.com/file?sig=1', 'https://api.example.com')).toBe('https://bucket.example.com/file?sig=1');
  });

  it('is the same-origin path in the test build, where VITE_API_URL is unset', () => {
    expect(apiUrl('/api/config')).toBe('/api/config');
  });
});

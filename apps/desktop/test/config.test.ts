// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { loadConfig, loadUpdateConfig, parseLudyUrl, parseUpdateUrl } from '../src/config.ts';

describe('parseLudyUrl', () => {
  it('keeps the origin of an https address', () => {
    expect(parseLudyUrl('https://ludy.example.vn/')).toEqual({ ok: true, url: 'https://ludy.example.vn' });
    expect(parseLudyUrl(' https://ludy.example.vn:8443 ')).toEqual({ ok: true, url: 'https://ludy.example.vn:8443' });
  });
  it('accepts plain http only for loopback development hosts', () => {
    for (const url of ['http://localhost:8080', 'http://127.0.0.1:8080', 'http://[::1]:8080', 'http://ludy.localhost']) expect(parseLudyUrl(url).ok).toBe(true);
    for (const url of ['http://ludy.example.vn', 'http://10.0.0.5', 'http://localhost.evil.com']) expect(parseLudyUrl(url).ok).toBe(false);
  });
  it('accepts self-hosted internal HTTPS origins for ludyUrl and refuses other schemes, credentials, paths, queries and junk', () => {
    for (const url of ['https://10.0.0.1', 'https://192.168.1.10', 'https://ludy.internal', 'https://[::ffff:127.0.0.1]']) {
      expect(parseLudyUrl(url).ok, url).toBe(true);
    }
    for (const url of [
      'ftp://ludy.example.vn',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'https://user:pw@ludy.example.vn',
      'https://ludy.example.vn/app',
      'https://ludy.example.vn/?a=1',
      'https://ludy.example.vn/#x',
      'not a url',
      '',
    ]) {
      expect(parseLudyUrl(url).ok, url).toBe(false);
    }
  });
});

describe('parseUpdateUrl (feed URL validation)', () => {
  it('requires https, except for local test feeds', () => {
    expect(parseUpdateUrl('https://updates.example.vn/ludy-desktop/')).toEqual({ ok: true, url: 'https://updates.example.vn/ludy-desktop' });
    expect(parseUpdateUrl('http://127.0.0.1:4010/feed')).toEqual({ ok: true, url: 'http://127.0.0.1:4010/feed' });
    expect(parseUpdateUrl('http://updates.example.vn/feed').ok).toBe(false);
    expect(parseUpdateUrl('https://u:p@updates.example.vn/feed').ok).toBe(false);
    expect(parseUpdateUrl('https://updates.example.vn/feed?token=1').ok).toBe(false);
  });

  it('blocks SSRF targets, relative traversal, and *.localhost on update feeds', () => {
    for (const bad of [
      'https://169.254.169.254/feed',
      'https://10.0.0.5/feed',
      'https://172.16.0.1/feed',
      'https://192.168.0.1/feed',
      'https://100.64.0.1/feed',
      'https://0.0.0.0/feed',
      'https://127.0.0.1/feed',
      'https://[::1]/feed',
      'https://[fe80::1]/feed',
      'https://[fc00::1]/feed',
      'https://[::ffff:169.254.169.254]/feed',
      'https://metadata.google.internal/feed',
      'https://intranet/feed',
      'http://ludy.localhost/feed',
      '//evil.example/feed',
      'https://updates.example.vn/feed/../other',
    ]) {
      expect(parseUpdateUrl(bad).ok, bad).toBe(false);
    }
  });

  it('resolves relative update paths against ludyUrl and enforces origin pinning', () => {
    expect(parseUpdateUrl('/desktop/win32-x64/', { ludyUrl: 'https://ludy.example.vn' })).toEqual({
      ok: true,
      url: 'https://ludy.example.vn/desktop/win32-x64',
    });
    expect(parseUpdateUrl('/desktop/win32-x64', { ludyUrl: null }).ok).toBe(false);
    expect(parseUpdateUrl('https://cdn.example.vn/feed', { allowedOrigin: 'https://updates.example.vn' }).ok).toBe(false);
    expect(parseUpdateUrl('https://updates.example.vn/feed', { allowedOrigin: 'https://updates.example.vn' })).toEqual({
      ok: true,
      url: 'https://updates.example.vn/feed',
    });
  });
});

describe('loadConfig', () => {
  it('takes the environment over the file and reports what it ignored', () => {
    const config = loadConfig({
      env: { LUDY_URL: 'https://env.example.vn' },
      configFile: JSON.stringify({ ludyUrl: 'https://file.example.vn', updateUrl: 'https://updates.example.vn/feed' }),
    });
    expect(config).toEqual({ ludyUrl: 'https://env.example.vn', updateUrl: 'https://updates.example.vn/feed', problems: [] });
  });
  it('has no default address and no update feed', () => {
    expect(loadConfig({ env: {}, configFile: null })).toEqual({ ludyUrl: null, updateUrl: null, problems: [] });
  });
  it('ignores an unsafe address and says so', () => {
    const config = loadConfig({ env: { LUDY_URL: 'http://ludy.example.vn', LUDY_DESKTOP_UPDATE_URL: 'http://updates.example.vn' }, configFile: null });
    expect(config.ludyUrl).toBeNull();
    expect(config.updateUrl).toBeNull();
    expect(config.problems).toHaveLength(2);
  });
  it('survives a broken config.json', () => {
    expect(loadConfig({ env: {}, configFile: '{nope' }).problems).toHaveLength(1);
    expect(loadConfig({ env: {}, configFile: '[]' }).problems).toHaveLength(1);
  });
});

describe('loadUpdateConfig pinning guardrails', () => {
  it('enforces LUDY_DESKTOP_UPDATE_ORIGIN and validates publisher thumbprint', () => {
    const thumb = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
    const good = loadUpdateConfig({
      env: {
        LUDY_URL: 'https://app.example.vn',
        LUDY_DESKTOP_UPDATE_URL: '/updates/win32',
        LUDY_DESKTOP_UPDATE_ORIGIN: 'https://app.example.vn',
        LUDY_DESKTOP_UPDATE_PUBLISHER_SHA1: thumb.toUpperCase(),
      },
      configFile: null,
    });
    expect(good).toEqual({
      ludyUrl: 'https://app.example.vn',
      updateUrl: 'https://app.example.vn/updates/win32',
      allowedUpdateOrigin: 'https://app.example.vn',
      expectedPublisherThumbprint: thumb,
      problems: [],
    });

    const mismatchedOrigin = loadUpdateConfig({
      env: {
        LUDY_DESKTOP_UPDATE_URL: 'https://other.example.vn/feed',
        LUDY_DESKTOP_UPDATE_ORIGIN: 'https://updates.example.vn',
      },
      configFile: null,
    });
    expect(mismatchedOrigin.updateUrl).toBeNull();
    expect(mismatchedOrigin.problems).toHaveLength(1);

    const badThumb = loadUpdateConfig({
      env: {
        LUDY_DESKTOP_UPDATE_URL: 'https://updates.example.vn/feed',
        LUDY_DESKTOP_UPDATE_PUBLISHER_SHA1: 'not-hex',
      },
      configFile: null,
    });
    expect(badThumb.updateUrl).toBeNull();
    expect(badThumb.problems).toHaveLength(1);

    const badPinTypes = loadUpdateConfig({
      env: {},
      configFile: JSON.stringify({
        updateUrl: 'https://updates.example.vn/feed',
        updateOrigin: 123,
        updatePublisherThumbprint: { bad: true },
      }),
    });
    expect(badPinTypes.updateUrl).toBeNull();
    expect(badPinTypes.problems).toHaveLength(2);
  });
});

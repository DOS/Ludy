// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { loadConfig, parseLudyUrl, parseUpdateUrl } from '../src/config.ts';

describe('parseLudyUrl', () => {
  it('keeps the origin of an https address', () => {
    expect(parseLudyUrl('https://ludy.example.vn/')).toEqual({ ok: true, url: 'https://ludy.example.vn' });
    expect(parseLudyUrl(' https://ludy.example.vn:8443 ')).toEqual({ ok: true, url: 'https://ludy.example.vn:8443' });
  });
  it('accepts plain http only for loopback development hosts', () => {
    for (const url of ['http://localhost:8080', 'http://127.0.0.1:8080', 'http://[::1]:8080', 'http://ludy.localhost']) expect(parseLudyUrl(url).ok).toBe(true);
    for (const url of ['http://ludy.example.vn', 'http://10.0.0.5', 'http://localhost.evil.com']) expect(parseLudyUrl(url).ok).toBe(false);
  });
  it('refuses other schemes, credentials, paths, queries and junk', () => {
    for (const url of ['ftp://ludy.example.vn', 'file:///etc/passwd', 'javascript:alert(1)', 'https://user:pw@ludy.example.vn', 'https://ludy.example.vn/app', 'https://ludy.example.vn/?a=1', 'https://ludy.example.vn/#x', 'not a url', '']) {
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

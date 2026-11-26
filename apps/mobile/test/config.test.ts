// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import appConfig from '../app.config.ts';
import { APP_SCHEME, cloudServerUrl, normalizeServerUrl, REDIRECT_URI, serverAllowed, serverPolicy } from '../src/config.ts';
import { AUTO_LOCK_AFTER_MS, shouldAutoLock } from '../src/auth/auto-lock.ts';

describe('server address', () => {
  it('accepts an https origin and normalizes it', () => {
    expect(normalizeServerUrl('https://api.ludy.vn')).toBe('https://api.ludy.vn');
    expect(normalizeServerUrl('  https://api.ludy.vn/ ')).toBe('https://api.ludy.vn');
    expect(normalizeServerUrl('https://Ludy.Example.com:8443')).toBe('https://ludy.example.com:8443');
  });

  it('accepts http only for the developer\'s own machine', () => {
    expect(normalizeServerUrl('http://localhost:8080')).toBe('http://localhost:8080');
    expect(normalizeServerUrl('http://127.0.0.1:8080')).toBe('http://127.0.0.1:8080');
    expect(normalizeServerUrl('http://ludy.example.com')).toBeNull();
    expect(normalizeServerUrl('http://localhost.example.com')).toBeNull();
  });

  it('refuses credentials, paths, queries, fragments, other schemes and junk', () => {
    for (const bad of ['', '   ', 'ludy.example.com', 'ftp://ludy.example.com', 'https://user:pw@ludy.example.com', 'https://ludy.example.com/app', 'https://ludy.example.com?x=1', 'https://ludy.example.com/#x', 'https://ludy.example.com?', 'javascript:alert(1)', `https://${'a'.repeat(300)}.com`]) {
      expect(normalizeServerUrl(bad)).toBeNull();
    }
  });

  it('hides the server field only for a build with a valid Cloud address', () => {
    expect(cloudServerUrl('https://api.ludy.vn')).toBe('https://api.ludy.vn');
    expect(cloudServerUrl(undefined)).toBeNull();
    expect(cloudServerUrl('')).toBeNull();
    expect(cloudServerUrl('not a url')).toBeNull();
  });
});

describe('server policy', () => {
  it('lets a Cloud build sign in to its own address only, and a build with no setting to none', () => {
    const cloud = serverPolicy('https://api.ludy.vn', undefined);
    expect(serverAllowed(cloud, 'https://api.ludy.vn')).toBe(true);
    expect(serverAllowed(cloud, 'https://evil.example')).toBe(false);
    expect(serverAllowed(serverPolicy(undefined, undefined), 'https://api.ludy.vn')).toBe(false);
    expect(serverAllowed(serverPolicy('junk', '0'), 'https://api.ludy.vn')).toBe(false);
  });

  it('shows the address field only for a build made for one operator', () => {
    expect(serverPolicy(undefined, '1')).toEqual({ kind: 'custom' });
    expect(serverAllowed(serverPolicy(undefined, '1'), 'https://ludy.congty.vn')).toBe(true);
    expect(serverPolicy('https://api.ludy.vn', '1').kind).toBe('cloud');
  });
});

describe('build configuration', () => {
  it('registers the scheme the redirect URI uses, and nothing else as a way back into the app', () => {
    expect(appConfig.scheme).toBe(APP_SCHEME);
    expect(REDIRECT_URI.startsWith(`${APP_SCHEME}://`)).toBe(true);
  });

  it('does not let the platform back the secure storage up, and holds no secret', () => {
    expect(appConfig.android?.allowBackup).toBe(false);
    const text = JSON.stringify(appConfig).toLowerCase();
    for (const word of ['secret', 'password', 'apikey', 'api_key', 'token', 'privatekey']) expect(text).not.toContain(word);
  });

  it('asks for the permissions of the biometric, with a reason in Vietnamese', () => {
    expect(String(appConfig.ios?.infoPlist?.['NSFaceIDUsageDescription'])).toMatch(/Face ID/);
  });
});

describe('auto lock', () => {
  it('locks after a minute in the background and not before', () => {
    expect(shouldAutoLock(null, 1000)).toBe(false);
    expect(shouldAutoLock(1000, 1000 + AUTO_LOCK_AFTER_MS - 1)).toBe(false);
    expect(shouldAutoLock(1000, 1000 + AUTO_LOCK_AFTER_MS)).toBe(true);
  });

  it('locks when the clock went backwards', () => {
    expect(shouldAutoLock(5000, 1000)).toBe(true);
  });
});

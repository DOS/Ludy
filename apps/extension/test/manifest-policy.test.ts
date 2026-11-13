// SPDX-License-Identifier: AGPL-3.0-only
// The manifest against the fixed permission list (meetings plan section 5.7): the base install and the meetings feature
// ask for nothing beyond it, and a permission added without changing the list fails.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { localeViolations, manifestViolations } from '../src/manifest-policy.ts';
import { FEATURES } from '../src/features.ts';

const manifest = (): Record<string, unknown> => JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8')) as Record<string, unknown>;

describe('manifest permission list', () => {
  it('the shipped manifest keeps it', () => {
    expect(manifestViolations(manifest())).toEqual([]);
  });

  it('the base install asks for storage and identity and one host, nothing else', () => {
    const m = manifest();
    expect(m.permissions).toEqual(['storage', 'identity']);
    expect(m.host_permissions).toEqual(['https://app.ludy.vn/*']);
  });

  it('meetings adds tabCapture and offscreen as optional permissions, and no site', () => {
    const m = manifest();
    const meetings = FEATURES.find((f) => f.id === 'meetings')!;
    expect([...meetings.permissions].sort()).toEqual([...(m.optional_permissions as string[])].sort());
    expect(meetings.permissions.some((p) => p.includes('/') || p.includes('*'))).toBe(false);
  });

  it.each([
    ['tabs', { permissions: ['storage', 'identity', 'tabs'] }],
    ['cookies', { permissions: ['storage', 'identity', 'cookies'] }],
    ['history', { optional_permissions: ['tabCapture', 'offscreen', 'history'] }],
    ['activeTab', { optional_permissions: ['tabCapture', 'offscreen', 'activeTab'] }],
    ['all_urls as a host', { host_permissions: ['https://app.ludy.vn/*', '<all_urls>'] }],
    ['all_urls as an optional host', { optional_host_permissions: ['<all_urls>'] }],
    ['a meeting site', { host_permissions: ['https://app.ludy.vn/*', 'https://meet.google.com/*'] }],
    ['a content script', { content_scripts: [{ matches: ['https://meet.google.com/*'], js: ['x.js'] }] }],
    ['externally_connectable', { externally_connectable: { matches: ['https://*/*'] } }],
    ['a missing permission', { permissions: ['storage'] }],
    ['manifest v2', { manifest_version: 2 }],
    ['unsafe-eval', { content_security_policy: { extension_pages: "script-src 'self' 'unsafe-eval'" } }],
    ['a remote script', { content_security_policy: { extension_pages: "script-src 'self' https://cdn.example.com" } }],
  ])('refuses %s', (_name, change) => {
    expect(manifestViolations({ ...manifest(), ...change }).length).toBeGreaterThan(0);
  });
});

const messagesOf = (lang: string): Record<string, { message: string }> => JSON.parse(readFileSync(new URL(`../_locales/${lang}/messages.json`, import.meta.url), 'utf8')) as Record<string, { message: string }>;
const locales = (): Record<string, Record<string, { message: string }>> => ({ vi: messagesOf('vi'), en: messagesOf('en') });

describe('localized manifest (the store listing in Vietnamese and English)', () => {
  it('the shipped manifest and message files keep the rules, and the version stays that of the package', () => {
    expect(localeViolations(manifest(), locales())).toEqual([]);
    expect(manifest().default_locale).toBe('vi');
  });

  it('the description is the store text in both languages, within the 132 character limit', () => {
    expect(messagesOf('en').extDescription!.message).toBe("Record a browser meeting's tab audio and your microphone into Ludy, and upload it when you stop.");
    for (const lang of ['vi', 'en']) expect(messagesOf(lang).extDescription!.message.length).toBeLessThanOrEqual(132);
  });

  it('adding the locales changes no permission', () => {
    expect(manifestViolations(manifest())).toEqual([]);
  });

  it.each([
    ['a hard-coded name', () => ({ manifest: { ...manifest(), name: 'Ludy' }, locales: locales() })],
    ['a hard-coded description', () => ({ manifest: { ...manifest(), description: 'Ghi lại cuộc họp' }, locales: locales() })],
    ['a hard-coded toolbar title', () => ({ manifest: { ...manifest(), action: { default_title: 'Ludy' } }, locales: locales() })],
    ['no default_locale', () => ({ manifest: Object.fromEntries(Object.entries(manifest()).filter(([k]) => k !== 'default_locale')), locales: locales() })],
    ['a missing English file', () => ({ manifest: manifest(), locales: { vi: messagesOf('vi') } })],
    ['a missing message', () => ({ manifest: manifest(), locales: { vi: messagesOf('vi'), en: { extName: { message: 'Ludy' } } } })],
    ['a description over 132 characters', () => ({ manifest: manifest(), locales: { vi: messagesOf('vi'), en: { ...messagesOf('en'), extDescription: { message: 'x'.repeat(133) } } } })],
  ])('refuses %s', (_name, build) => {
    const { manifest: m, locales: l } = build();
    expect(localeViolations(m as Record<string, unknown>, l).length).toBeGreaterThan(0);
  });
});

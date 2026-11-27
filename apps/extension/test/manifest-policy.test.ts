// SPDX-License-Identifier: AGPL-3.0-only
// The manifest against the fixed permission list (meetings plan section 5.7): the Chrome Web Store package locks to
// Ludy Cloud (`https://api.ludy.vn/*` for host_permissions, `https://app.ludy.vn/*` for web_accessible_resources, and
// zero optional_host_permissions), and any permission added or loosened without changing the list fails.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_APP_MATCHES, DEFAULT_HOST_PERMISSIONS, DEFAULT_LOCALE, localeViolations, manifestViolations, OPTIONAL_PERMISSIONS, WEB_ACCESSIBLE_PAGE, WEB_CLIPPER_OPTIONAL_PERMISSIONS } from '../src/manifest-policy.ts';
import { FEATURES } from '../src/features.ts';

const manifest = (): Record<string, unknown> => JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8')) as Record<string, unknown>;

describe('manifest permission list', () => {
  it('the shipped manifest keeps the Ludy Cloud policy', () => {
    expect(manifestViolations(manifest())).toEqual([]);
  });

  it('the shipped manifest declares exactly the sign-in landing page for app.ludy.vn only (#4662, #5224)', () => {
    expect(DEFAULT_APP_MATCHES).toEqual(['https://app.ludy.vn/*']);
    expect(manifest().web_accessible_resources).toEqual([{ resources: [WEB_ACCESSIBLE_PAGE], matches: ['https://app.ludy.vn/*'] }]);
  });

  it('no web accessible resource at all, or exactly the sign-in landing page for the app origin, keeps the list', () => {
    const without = { ...manifest() };
    delete without.web_accessible_resources;
    expect(manifestViolations(without)).toEqual([]);
    const pinned = { ...manifest(), web_accessible_resources: [{ resources: ['connected.html'], matches: ['https://app.ludy.vn/*'] }] };
    expect(manifestViolations(pinned)).toEqual([]);
  });

  it('the base install asks for storage, identity, and api.ludy.vn only, with no optional_host_permissions', () => {
    const m = manifest();
    expect(DEFAULT_HOST_PERMISSIONS).toEqual(['https://api.ludy.vn/*']);
    expect(m.permissions).toEqual(['storage', 'identity']);
    expect(m.host_permissions).toEqual(['https://api.ludy.vn/*']);
    expect('optional_host_permissions' in m).toBe(false);
  });

  it('accepts custom app/api match patterns only when explicitly checked for a self-host build', () => {
    const selfHost = {
      ...manifest(),
      host_permissions: ['https://api.company.example/*'],
      web_accessible_resources: [{ resources: ['connected.html'], matches: ['https://app.company.example/*'] }],
    };
    expect(manifestViolations(selfHost).length).toBeGreaterThan(0);
    expect(
      manifestViolations(selfHost, {
        hostPermissions: ['https://api.company.example/*'],
        appMatches: ['https://app.company.example/*'],
      }),
    ).toEqual([]);
    expect(
      manifestViolations(
        { ...selfHost, optional_host_permissions: ['https://*/*'] },
        { hostPermissions: ['https://api.company.example/*'], appMatches: ['https://app.company.example/*'] },
      ).length,
    ).toBeGreaterThan(0);
  });

  it('meetings and web clipper add only their declared optional permissions, and Quick Capture adds none', () => {
    const m = manifest();
    const meetings = FEATURES.find((f) => f.id === 'meetings')!;
    const notes = FEATURES.find((f) => f.id === 'notes')!;
    expect(notes.permissions).toEqual([]);
    expect([...WEB_CLIPPER_OPTIONAL_PERMISSIONS].sort()).toEqual(['activeTab', 'scripting']);
    expect([...OPTIONAL_PERMISSIONS].sort()).toEqual(['activeTab', 'offscreen', 'scripting', 'tabCapture']);
    expect([...new Set([...meetings.permissions, ...WEB_CLIPPER_OPTIONAL_PERMISSIONS])].sort()).toEqual([...(m.optional_permissions as string[])].sort());
    expect(meetings.permissions).toContain('activeTab');
    expect(OPTIONAL_PERMISSIONS.some((p) => p.includes('/') || p.includes('*'))).toBe(false);
  });

  it.each([
    ['tabs', { permissions: ['storage', 'identity', 'tabs'] }],
    ['cookies', { permissions: ['storage', 'identity', 'cookies'] }],
    ['activeTab as a required permission', { permissions: ['storage', 'identity', 'activeTab'] }],
    ['scripting as a required permission', { permissions: ['storage', 'identity', 'scripting'] }],
    ['history', { optional_permissions: ['tabCapture', 'offscreen', 'activeTab', 'scripting', 'history'] }],
    ['missing scripting from optional_permissions', { optional_permissions: ['tabCapture', 'offscreen', 'activeTab'] }],
    ['optional_host_permissions wildcard', { optional_host_permissions: ['https://*/*'] }],
    ['optional_host_permissions localhost', { optional_host_permissions: ['http://localhost/*'] }],
    ['empty optional_host_permissions', { optional_host_permissions: [] }],
    ['all_urls as a host', { host_permissions: ['https://api.ludy.vn/*', '<all_urls>'] }],
    ['app.ludy.vn instead of api.ludy.vn as host', { host_permissions: ['https://app.ludy.vn/*'] }],
    ['a meeting site', { host_permissions: ['https://api.ludy.vn/*', 'https://meet.google.com/*'] }],
    ['a content script', { content_scripts: [{ matches: ['https://meet.google.com/*'], js: ['x.js'] }] }],
    ['externally_connectable', { externally_connectable: { matches: ['https://*/*'] } }],
    ['web_accessible_resources for every site', { web_accessible_resources: [{ resources: ['connected.html'], matches: ['https://*/*'] }] }],
    ['web_accessible_resources for all urls', { web_accessible_resources: [{ resources: ['connected.html'], matches: ['<all_urls>'] }] }],
    ['web_accessible_resources with localhost in store manifest', { web_accessible_resources: [{ resources: ['connected.html'], matches: ['https://app.ludy.vn/*', 'http://localhost/*'] }] }],
    ['a second web accessible page', { web_accessible_resources: [{ resources: ['connected.html', 'popup.html'], matches: ['https://app.ludy.vn/*'] }] }],
    ['web_accessible_resources of a second entry', { web_accessible_resources: [{ resources: ['connected.html'], matches: ['https://app.ludy.vn/*'] }, { resources: ['popup.html'], matches: ['https://app.ludy.vn/*'] }] }],
    ['web_accessible_resources limited to extension ids', { web_accessible_resources: [{ resources: ['connected.html'], matches: ['https://app.ludy.vn/*'], extension_ids: ['*'] }] }],
    ['web_accessible_resources with a dynamic url', { web_accessible_resources: [{ resources: ['connected.html'], matches: ['https://app.ludy.vn/*'], use_dynamic_url: true }] }],
    ['web_accessible_resources that is not a list', { web_accessible_resources: {} }],
    ['an empty web_accessible_resources list', { web_accessible_resources: [] }],
    ['the cloud app address missing from web_accessible_resources', { web_accessible_resources: [{ resources: ['connected.html'], matches: ['http://localhost/*'] }] }],
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
  it('the shipped manifest and message files keep the rules, with Vietnamese as the default', () => {
    expect(localeViolations(manifest(), locales())).toEqual([]);
    expect(manifest().default_locale).toBe(DEFAULT_LOCALE);
  });

  it('the description is the store text in both languages, within the 132 character limit', () => {
    expect(messagesOf('en').extDescription!.message).toBe('Record browser meeting audio and your mic into Ludy, and optionally save quick notes or clip the active page on click.');
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
    ['English as the default language', () => ({ manifest: { ...manifest(), default_locale: 'en' }, locales: locales() })],
    ['a default language with no folder', () => ({ manifest: { ...manifest(), default_locale: 'fr' }, locales: locales() })],
    ['a default language named like an object property', () => ({ manifest: { ...manifest(), default_locale: 'constructor' }, locales: locales() })],
    ['a message file that is null', () => ({ manifest: manifest(), locales: { vi: messagesOf('vi'), en: null } })],
    ['a name over 75 characters', () => ({ manifest: manifest(), locales: { vi: { ...messagesOf('vi'), extName: { message: 'x'.repeat(76) } }, en: messagesOf('en') } })],
    ['a Vietnamese description over 132 characters', () => ({ manifest: manifest(), locales: { vi: { ...messagesOf('vi'), extDescription: { message: 'x'.repeat(133) } }, en: messagesOf('en') } })],
    ['a missing English file', () => ({ manifest: manifest(), locales: { vi: messagesOf('vi') } })],
    ['a missing message', () => ({ manifest: manifest(), locales: { vi: messagesOf('vi'), en: { extName: { message: 'Ludy' } } } })],
    ['a description over 132 characters', () => ({ manifest: manifest(), locales: { vi: messagesOf('vi'), en: { ...messagesOf('en'), extDescription: { message: 'x'.repeat(133) } } } })],
  ])('refuses %s', (_name, build) => {
    const { manifest: m, locales: l } = build();
    expect(localeViolations(m as Record<string, unknown>, l as Parameters<typeof localeViolations>[1]).length).toBeGreaterThan(0);
  });
});
